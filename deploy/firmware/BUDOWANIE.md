# Budowanie firmware koparki z łatką Hajsomatu

Efektem jest jeden plik `esp-miner.bin`, który wgrywasz na koparkę przez jej
własną stronę (zakładka **Update**) albo kablem USB.

Wszystko sprawdzone pod **ESP-Miner v2.14.2**. Nazwy pól w strukturach zmieniają
się między wydaniami — przy innej wersji przeczytaj sekcję „Zgodność z wersją"
na początku `hajsomat_task.c`.

---

## 0. Czego potrzebujesz

| | |
|---|---|
| ESP-IDF | **v5.5.3** — tej używa ich CI do budowania v2.14.2 |
| miejsce na dysku | ~8 GB (samo ESP-IDF to gros) |
| czas | instalacja 30–60 min, potem każda budowa ~10 min |

Instalator na Windows: **Espressif → ESP-IDF Windows Installer**, przy wyborze
wersji zaznacz `v5.5.3`. Instalator sam zakłada skrót **ESP-IDF PowerShell**
— wszystkie polecenia niżej wykonujesz **w tym oknie**, nie w zwykłym wierszu
poleceń. Bez tego `idf.py` nie będzie widoczne.

---

## 1. Pobierz kod ESP-Miner w wersji v2.14.2

```
git clone --branch v2.14.2 --depth 1 --recurse-submodules https://github.com/bitaxeorg/ESP-Miner.git
cd ESP-Miner
```

`--recurse-submodules` jest **obowiązkowe**. ESP-Miner trzyma `libsecp256k1`
w osobnym repozytorium; bez tego katalog zostaje pusty i cmake przerywa
komunikatem:

```
Include directory '.../components/libsecp256k1/libsecp256k1/include' is not a directory.
```

Gdyby jednak wyszło — doklejasz to po fakcie:

```
git submodule update --init --recursive --depth 1
```

## 2. Wgraj naszą łatkę

Skopiuj oba pliki z `deploy/firmware/` do `main/tasks/`:

```
copy ..\Hajsomat\deploy\firmware\hajsomat_task.c main\tasks\
copy ..\Hajsomat\deploy\firmware\hajsomat_task.h main\tasks\
```

## 3. Cztery drobne zmiany w ich kodzie

### a) `main/CMakeLists.txt`

W liście `SRCS`, obok pozostałych zadań (okolice linii 32–41), dopisz linijkę:

```cmake
    "./tasks/hajsomat_task.c"
```

Oraz — w tym samym pliku, niżej — w bloku `PRIV_REQUIRES`, alfabetycznie tuż
przed `"esp_http_server"`:

```cmake
    "esp_http_client"
```

Bez tego kompilator nie widzi `esp_http_client.h`. Łatwo to przeoczyć, bo błąd
wychodzi dopiero pod sam koniec budowania — u nas przeszło 1638 z 1648 plików
i wywalił się wyłącznie nasz.

### b) `main/main.c` — nagłówek

Obok pozostałych `#include`, w okolicy linii 9:

```c
#include "hajsomat_task.h"
```

### c) `main/main.c` — uruchomienie zadania

Znajdź tworzenie zadania `statistics` (w v2.14.2 linie 160–162) i **zaraz za
zamykającą klamrą** wstaw:

```c
            if (xTaskCreateWithCaps(hajsomat_task, "hajsomat", 8192,
                                    (void *) &GLOBAL_STATE, 2, NULL,
                                    MALLOC_CAP_SPIRAM) != pdPASS) {
                ESP_LOGE(TAG, "Error creating hajsomat task");
            }
```

Wcięcie ma się zgadzać z sąsiadującym `if` — to jest wnętrze tego samego bloku.

### d) `sdkconfig.defaults` — samoczynne cofnięcie

Dopisz na końcu pliku:

```
CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y
```

**To jest nasza siatka bezpieczeństwa.** Świeżo wgrany obraz startuje jako
„niepotwierdzony". Nasze zadanie potwierdza go dopiero po trzech minutach
z działającym kopaniem. Jeśli coś położy koparkę i ta się zrestartuje,
bootloader **sam** wróci do poprzedniej wersji.

Skutek uboczny, o którym trzeba wiedzieć: jeśli odetniesz prąd w pierwszych
trzech minutach po wgraniu, koparka wstanie na starej wersji. To nie awaria.

## 4. Wpisz swoje dane

W `main/tasks/hajsomat_task.c`, na początku pliku:

```c
#define ADRES_SERWERA "http://136.65.32.111:8787/bitaxe"
#define KLUCZ         "TU-WPISZ-DLUGI-LOSOWY-CIAG"
```

Klucz odczytasz na serwerze:

```
grep BITAXE_KLUCZ ~/hajsomat/deploy/.env
```

Musi być **dokładnie ten sam** ciąg, co w `deploy/.env`. Przy niezgodności
serwer odpowie kodem 403, a w logu koparki zobaczysz `serwer odpowiedzial 403`.

## 5. Zbuduj

```
idf.py set-target esp32s3
idf.py build
```

Gotowy plik: **`build/esp-miner.bin`**

## 6. Wgraj

Przez stronę koparki: `http://192.168.0.100` → **Update** → pole firmware →
wskaż `build/esp-miner.bin`. Pliku `www.bin` **nie ruszamy** — interfejs się
nie zmienił.

Albo kablem, jeśli wolisz mieć podgląd logów:

```
idf.py -p COM3 flash monitor
```

## 7. Sprawdź, że działa

Na koparce (po jakichś dwóch minutach):

```
curl -s http://192.168.0.100/api/system/info | grep -o "\"version\":[^,]*"
```

Na serwerze:

```
journalctl -u hajsomat-odbiornik -f
```

Co minutę ma się pojawiać linijka `zapisane: 1.05 TH/s, uklad 60°C`.

I plik z ostatnim odczytem:

```
cat ~/hajsomat/state/bitaxe.json
```

---

## Gdyby coś poszło nie tak

**Koparka wstała, ale nic nie wysyła.** Podłącz `idf.py -p COM3 monitor`
i szukaj linii z `hajsomat`. Kod `403` to niezgodny klucz, `nie wyslano:
ESP_ERR_HTTP_CONNECT` to zapora albo zły adres.

**Koparka nie wstała.** Odczekaj — po pierwszym restarcie bootloader powinien
sam cofnąć się do poprzedniej wersji. Jeśli nie, wgraj fabryczny obraz przez USB:

```
python -m esptool --chip esp32s3 erase_flash
python -m esptool --chip esp32s3 --baud 921600 write_flash 0x0 esp-miner-factory-601-v2.14.2.bin
```

Uwaga: `erase_flash` kasuje też ustawienia, więc portfel, częstotliwość
i wentylator trzeba będzie wpisać od nowa.
