/*
 * WYSYLANIE ODCZYTOW NA WLASNY SERWER — latka do ESP-Miner (AxeOS) v2.14.2.
 *
 * Bitaxe stoi za routerem i z internetu nikt do niego nie dojdzie, ale
 * polaczenia WYCHODZACE z domu przechodza bez zadnej konfiguracji. To zadanie
 * z tego korzysta: co ODSTEP_S sekund wysyla POST z odczytem na serwer o stalym
 * adresie publicznym. Serwer zapisuje go do `state/bitaxe.json`, a stamtad przy
 * najblizszym commicie trafia na GitHuba i do apki.
 *
 * ── GDZIE TO WSTAWIC ────────────────────────────────────────────────────────
 *
 *  1. Ten plik → `main/tasks/hajsomat_task.c`, naglowek → `main/tasks/hajsomat_task.h`.
 *  2. W `main/CMakeLists.txt`, do listy SRCS, dopisz:  "./tasks/hajsomat_task.c"
 *  3. W `main/main.c` dodaj `#include "hajsomat_task.h"` obok pozostalych,
 *     a zaraz PO utworzeniu zadania "statistics" (w v2.14.2 linie 160-162) wstaw:
 *
 *         if (xTaskCreateWithCaps(hajsomat_task, "hajsomat", 8192,
 *                                 (void *) &GLOBAL_STATE, 2, NULL,
 *                                 MALLOC_CAP_SPIRAM) != pdPASS) {
 *             ESP_LOGE(TAG, "Error creating hajsomat task");
 *         }
 *
 *  4. W `sdkconfig.defaults` dopisz:  CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y
 *  5. Ustaw ponizej ADRES_SERWERA i KLUCZ, potem zbuduj i wgraj.
 *
 * ── DECYZJE, KTORE WARTO ZNAC ───────────────────────────────────────────────
 *
 * PRIORYTET 2 — nizszy niz statystyki (3) i duzo nizszy niz kopanie (15-20).
 * To zadanie ma prawo czekac. Kopanie nie.
 *
 * BLAD SIECI NICZEGO NIE PRZERYWA. Kazde niepowodzenie to wpis w logu i czekanie
 * do nastepnego razu. Koparka ma kopac takze wtedy, gdy serwer lezy, router sie
 * restartuje albo ktos zmienil haslo do Wi-Fi.
 *
 * BUFOR NA STOSIE, nie na stercie: jeden bufor stalego rozmiaru, budowany od nowa
 * przy kazdym wyslaniu. Nie ma czego gubic ani zwalniac.
 *
 * NAZWY POL takie same jak w `/api/system/info` — dzieki temu serwer i apka nie
 * musza rozrozniac, czy odczyt przyszedl z sieci domowej, czy tą droga.
 *
 * ── ZGODNOSC Z WERSJA ───────────────────────────────────────────────────────
 *
 * Pisane i sprawdzone pod ESP-Miner v2.14.2. Pierwsza wersja tej latki uzywala
 * `sys->pools[i].user` oraz `sys->primary_pool_index` — pol, ktore istnieja
 * dopiero w galezi rozwojowej. W v2.14.2 pule sa PLASKIE (`pool_user`,
 * `fallback_pool_user`), a o tym, ktora jest w uzyciu, mowi `use_fallback_stratum`.
 * Przy przesiadce na nowsze wydanie to jest pierwsze miejsce do sprawdzenia.
 */

#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_http_client.h"
#include "esp_app_desc.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hajsomat_task.h"
#include "global_state.h"

/* ── USTAW TO PRZED BUDOWANIEM ──────────────────────────────────────────── */
#define ADRES_SERWERA "http://136.65.32.111:8787/bitaxe"
#define KLUCZ         "TU-WPISZ-DLUGI-LOSOWY-CIAG"
#define ODSTEP_S      60
/* ──────────────────────────────────────────────────────────────────────── */

/*
 * Po ilu cyklach z dzialajacym kopaniem uznajemy obraz za sprawny.
 * 3 cykle po 60 s = trzy minuty. Patrz komentarz przy `zatwierdz_obraz`.
 */
#define ZATWIERDZ_PO 3

static const char * TAG = "hajsomat";

/*
 * Odczyt to okolo 600 bajtow razem z adresem portfela i adresem puli.
 * 1024 daje zapas, a przy 8 kB stosu zadania to dalej nic.
 *
 * UWAGA przy dopisywaniu pol tekstowych: nie sa tu w zaden sposob escapowane.
 * Adres bitcoina i adres puli to znaki alfanumeryczne z kropkami, wiec JSON
 * z nich nie wyjdzie zepsuty — ale gdyby kiedys doszlo pole, ktore moze
 * zawierac cudzyslow, trzeba je przepuscic przez escapowanie albo pominac.
 */
#define BUFOR 1024

/**
 * ZATWIERDZENIE OBRAZU — siec bezpieczenstwa przy wgrywaniu przez OTA.
 *
 * Przy wlaczonym CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE swiezo wgrany obraz
 * startuje w stanie PENDING_VERIFY. Jesli aplikacja nie zglosi, ze dziala,
 * i urzadzenie sie zrestartuje, bootloader SAM wraca do poprzedniej wersji.
 *
 * KRYTERIUM JEST KOPANIE, NIE WYSYLKA. Gdybysmy zatwierdzali obraz dopiero po
 * udanym POST, to awaria serwera albo zerwane Wi-Fi cofnelyby firmware —
 * a przeciez wtedy koparka dziala bez zarzutu. Pytamy wiec o jedno: czy ASIC
 * liczy. Jesli tak, to system wstal, sterowniki weszly, pula odpowiada —
 * czyli nasz dodatek niczego nie polamal.
 *
 * CZEGO TO NIE OBEJMUJE: zawieszenia bez restartu. Cofniecie dzieje sie przy
 * ponownym uruchomieniu, wiec ratuje przed padem w petli (najczestszy przypadek),
 * a nie przed cichym zwisem. Od tego jest kabel USB.
 *
 * SKUTEK UBOCZNY, o ktorym trzeba wiedziec: jesli odetniesz prad w ciagu
 * pierwszych trzech minut po wgraniu, koparka wstanie na STAREJ wersji.
 * To nie awaria, tylko dzialanie zgodne z zamierzeniem.
 *
 * Wywolujemy najwyzej raz — potem `*cykle` zostaje na -1 i funkcja od razu wraca.
 */
static void zatwierdz_obraz(SystemModule * sys, int * cykle)
{
    if (*cykle < 0) return;                        /* juz zalatwione */
    if (!(sys->current_hashrate > 0)) return;      /* jeszcze nie kopie */
    if (++(*cykle) < ZATWIERDZ_PO) return;

    esp_ota_img_states_t stan;
    const esp_partition_t * part = esp_ota_get_running_partition();
    if (part && esp_ota_get_state_partition(part, &stan) == ESP_OK
        && stan == ESP_OTA_IMG_PENDING_VERIFY) {
        esp_ota_mark_app_valid_cancel_rollback();
        ESP_LOGI(TAG, "obraz zatwierdzony — cofniecie odwolane");
    }
    *cykle = -1;
}

void hajsomat_task(void * pvParameters)
{
    ESP_LOGI(TAG, "Starting, cel: %s co %d s", ADRES_SERWERA, ODSTEP_S);

    GlobalState * GLOBAL_STATE = (GlobalState *) pvParameters;
    SystemModule * sys = &GLOBAL_STATE->SYSTEM_MODULE;
    PowerManagementModule * pwr = &GLOBAL_STATE->POWER_MANAGEMENT_MODULE;

    char tresc[BUFOR];

    /* Ile razy pod rzad nie udalo sie wyslac. Sluzy do wycofywania sie —
       patrz komentarz przy `mnoznik` na koncu petli. */
    int pudla = 0;
    /* Licznik cykli do zatwierdzenia obrazu; -1 znaczy "zalatwione". */
    int cykle = 0;

    /* `vTaskDelayUntil` zamiast `vTaskDelay`, tak jak w statistics_task:
       odmierza od USTALONEJ chwili, a nie od konca poprzedniej roboty.
       Przy `vTaskDelay` kazde wyslanie (do 8 s przy zerwanej sieci) dokladalo
       sie do odstepu i "co minute" zamienialo sie w "co minute i troche". */
    TickType_t budzik = xTaskGetTickCount();

    /* Pierwsze wyslanie dopiero po odstepie, nie od razu: przy starcie Wi-Fi
       bywa jeszcze niepodniesione, a moc obliczeniowa i tak jest wtedy zerowa. */
    vTaskDelayUntil(&budzik, pdMS_TO_TICKS(ODSTEP_S * 1000));

    while (1) {
        zatwierdz_obraz(sys, &cykle);

        /* UWAGA na typy: `core_voltage`, `fan_perc` i `frequency_value` sa
           w tej strukturze liczbami zmiennoprzecinkowymi, mimo ze wygladaja
           na calkowite. Formatowanie ich przez %d jest niezdefiniowanym
           zachowaniem — dlatego wszedzie tutaj jest %.0f albo %.1f. */

        /*
         * Ktora pula jest w uzyciu. Przy przelaczeniu na zapasowa adres
         * portfela moze byc inny, a apka ma pokazywac ten, na ktory NAPRAWDE
         * ida udzialy. W v2.14.2 pola sa plaskie, a nie tablica.
         */
        const bool zapas   = sys->use_fallback_stratum;
        const char * pUser = zapas ? sys->fallback_pool_user : sys->pool_user;
        const char * pUrl  = zapas ? sys->fallback_pool_url  : sys->pool_url;
        if (!pUser) pUser = "";
        if (!pUrl)  pUrl  = "";

        const char * plytka = GLOBAL_STATE->DEVICE_CONFIG.board_version
            ? GLOBAL_STATE->DEVICE_CONFIG.board_version : "";
        const char * uklad = GLOBAL_STATE->DEVICE_CONFIG.family.asic.name
            ? GLOBAL_STATE->DEVICE_CONFIG.family.asic.name : "";

        int n = snprintf(tresc, sizeof(tresc),
            "{\"hashRate\":%.2f,\"hashRate_10m\":%.2f,\"errorPercentage\":%.3f,"
            "\"temp\":%.1f,\"temp2\":%.1f,\"vrTemp\":%.1f,"
            "\"power\":%.2f,\"voltage\":%.1f,\"current\":%.1f,"
            "\"coreVoltageActual\":%.0f,\"frequency\":%.1f,"
            "\"fanspeed\":%.0f,\"fanrpm\":%u,\"fan2rpm\":%u,"
            "\"sharesAccepted\":%llu,\"sharesRejected\":%llu,"
            "\"bestDiff\":%llu,\"bestSessionDiff\":%llu,"
            "\"uptimeSeconds\":%lld,\"isUsingFallbackStratum\":%d,"
            "\"ASICModel\":\"%s\",\"boardVersion\":\"%s\",\"version\":\"%s\","
            "\"stratumURL\":\"%s\",\"stratumUser\":\"%s\"}",
            sys->current_hashrate, sys->hashrate_10m, sys->error_percentage,
            pwr->chip_temp_avg, pwr->chip_temp2_avg, pwr->vr_temp,
            pwr->power, pwr->voltage, pwr->current,
            pwr->core_voltage, pwr->frequency_value,
            pwr->fan_perc, (unsigned) pwr->fan_rpm, (unsigned) pwr->fan2_rpm,
            (unsigned long long) sys->shares_accepted,
            (unsigned long long) sys->shares_rejected,
            (unsigned long long) sys->best_nonce_diff,
            (unsigned long long) sys->best_session_nonce_diff,
            (long long) (esp_timer_get_time() / 1000000),
            zapas ? 1 : 0,
            uklad, plytka,
            /* `version` NIE jest w SystemModule — tamtejsze pole o tej nazwie
               nalezy do struktury opisujacej partycje, nie do stanu systemu.
               Wersje firmware bierzemy tak, jak robi to ESP-IDF. */
            esp_app_get_description()->version,
            pUrl, pUser);

        if (n <= 0 || n >= (int) sizeof(tresc)) {
            /* Ucieta tresc bylaby niepoprawnym JSON-em. Lepiej nie wyslac nic,
               niz wyslac smieci, ktore serwer i tak odrzuci. */
            ESP_LOGW(TAG, "odczyt nie zmiescil sie w buforze, pomijam");
        } else {
            esp_http_client_config_t cfg = {
                .url = ADRES_SERWERA,
                .method = HTTP_METHOD_POST,
                /* Bez limitu czasu zawieszone polaczenie trzymaloby zadanie
                   w nieskonczonosc — a ono ma sie odzywac co minute. */
                .timeout_ms = 8000,
            };
            esp_http_client_handle_t k = esp_http_client_init(&cfg);
            if (k) {
                esp_http_client_set_header(k, "Content-Type", "application/json");
                esp_http_client_set_header(k, "x-klucz", KLUCZ);
                esp_http_client_set_post_field(k, tresc, n);

                esp_err_t err = esp_http_client_perform(k);
                if (err == ESP_OK) {
                    int kod = esp_http_client_get_status_code(k);
                    if (kod == 200) {
                        ESP_LOGI(TAG, "wyslane (%d B)", n);
                        pudla = 0;
                    } else {
                        /* Serwer odpowiedzial, ale odmowil — to nie jest awaria
                           sieci, wiec nie wycofujemy sie. Najczesciej zly klucz,
                           a to trzeba zobaczyc w logu, a nie wyciszyc. */
                        ESP_LOGW(TAG, "serwer odpowiedzial %d", kod);
                    }
                } else {
                    if (pudla < 100) pudla++;
                    /* Log tylko przy pierwszych probach. Przy zerwanej sieci
                       na dobe to byloby 1440 ostrzezen, ktore wypchnelyby
                       z bufora logow wszystko, co naprawde warto przeczytac. */
                    if (pudla <= 3) {
                        ESP_LOGW(TAG, "nie wyslano: %s", esp_err_to_name(err));
                    }
                }
                esp_http_client_cleanup(k);
            } else {
                ESP_LOGW(TAG, "nie udalo sie utworzyc klienta HTTP");
            }
        }

        /*
         * WYCOFYWANIE SIE PRZY ZERWANEJ SIECI.
         *
         * Gdy serwer nie odpowiada, kazda proba to osiem sekund czekania
         * i pelna procedura DNS plus TCP. Powtarzanie tego co minute przez
         * cala noc nic nie daje, a kosztuje prad i zajmuje stos sieciowy,
         * z ktorego korzysta takze polaczenie z pula.
         *
         * Po trzech pudlach odstep rosnie do pieciu minut. Pierwsze udane
         * wyslanie kasuje licznik i wracamy do minuty.
         */
        const int mnoznik = (pudla > 3) ? 5 : 1;
        vTaskDelayUntil(&budzik, pdMS_TO_TICKS(ODSTEP_S * 1000 * mnoznik));
    }
}
