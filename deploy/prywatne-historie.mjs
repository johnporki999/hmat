/** Jednorazowa migracja publikacji: kopia -> weryfikacja -> git rm --cached.
 * Nie usuwa danych z dysku, nie uruchamia botow, nie wykonuje transakcji.
 * Wywolywana przez run.sh pod jego flock. Przy bledzie nie wolno publikowac.
 * Kopia na tym samym serwerze nie zastepuje niezaleznego backupu poza nim.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function prywatnaHistoria(name) {
  return /^state\/dane\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)
    || /^state\/(?:liga|liga-b|liga-c|liga-hl|forward-panika)-(?:state|equity|trades)\.json$/.test(name);
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function git(root, args, names) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    input: names ? names.join('\n')+'\n' : undefined });
}
export function archiwizuj(root) {
  root = fs.realpathSync(root);
  if (fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !== root) {
    throw new Error('Wymagany katalog glowny repozytorium');
  }
  const names = git(root, ['ls-files', '-z', '--', 'state']).split('\0').filter(prywatnaHistoria);
  if (!names.length) return { migrated: 0 };
  // Bez zgodnej .gitignore kolejny git add state moglby cofnac migracje.
  const ignored = git(root, ['check-ignore', '--no-index', '--stdin'], names);
  const ignoredNames = new Set(ignored.trim().split(/\r?\n/));
  if (names.some(n => !ignoredNames.has(n))) throw new Error('Brak reguly ignorowania historii');
  const parent = path.dirname(root);
  if (parent === root) throw new Error('Repozytorium nie moze byc korzeniem dysku');
  const archiveRoot = path.join(parent, `${path.basename(root)}-archiwum`);
  if (fs.existsSync(archiveRoot) && fs.lstatSync(archiveRoot).isSymbolicLink()) throw new Error('Archiwum jest dowiazaniem');
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  const archive = fs.mkdtempSync(path.join(archiveRoot, 'historie-'));
  const manifest = { version: 1, createdAt: new Date().toISOString(),
    commit: git(root, ['rev-parse', 'HEAD']).trim(), files: [] };
  for (const name of names) {
    const source = path.join(root, name);
    // Nie archiwizujemy dowiazan ani danych spoza wskazanego state/.
    for (const dir of [path.join(root, 'state'), path.dirname(source)]) {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Dowiazanie: ${dir}`);
    }
    if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error(`Brak zwyklego pliku: ${name}`);
    const bytes = fs.readFileSync(source);
    const dest = path.join(archive, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
    const sha256 = hash(bytes);
    if (hash(fs.readFileSync(dest)) !== sha256) throw new Error(`Niezgodna kopia: ${name}`);
    manifest.files.push({ name, bytes: bytes.length, sha256 });
  }
  const mf = path.join(archive, 'MANIFEST.json');
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
  const verified = JSON.parse(fs.readFileSync(mf, 'utf8'));
  for (const entry of verified.files) {
    if (hash(fs.readFileSync(path.join(archive, entry.name))) !== entry.sha256
      || hash(fs.readFileSync(path.join(root, entry.name))) !== entry.sha256) {
      throw new Error(`Plik zmienil sie w czasie archiwizacji: ${entry.name}`);
    }
  }
  // Dopiero po sprawdzeniu WSZYSTKICH kopii. --cached zachowuje oryginaly.
  for (let i=0; i<names.length; i+=50) git(root, ['rm', '--cached', '--', ...names.slice(i,i+50)]);
  if (git(root, ['ls-files', '-z', '--', 'state']).split('\0').some(prywatnaHistoria)) throw new Error('Niepelne wycofanie z indeksu');
  for (const entry of verified.files) {
    if (hash(fs.readFileSync(path.join(root, entry.name))) !== entry.sha256) throw new Error('Oryginal zmieniony');
  }
  return { migrated: names.length, archive, bytes: verified.files.reduce((s,f)=>s+f.bytes,0) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = archiwizuj(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    if (result.migrated) console.log('Historie zachowane poza Git:', JSON.stringify(result));
  } catch (e) { console.error('BLAD bezpiecznej archiwizacji:', e.message); process.exitCode=1; }
}
