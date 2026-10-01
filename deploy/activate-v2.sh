#!/bin/sh
# Owner-run release switch. The assistant does not execute this script.
set -eu
release=/var/www/example.com/beebots/releases/2.0.0
node=/opt/beebots-runtime/node
test "$(id -u)" = 0 || { echo 'Run with sudo'; exit 1; }
test -f "$release/src/main.mjs"
backup="/root/beebots-v2-backup-$(date +%Y%m%d-%H%M%S)"
install -d -m 0700 "$backup"
cp /etc/beebots/config.json "$backup/config.json"
if test -f /etc/systemd/system/beebots.service.d/release.conf; then
 cp /etc/systemd/system/beebots.service.d/release.conf "$backup/release.conf"
fi
# SQLite online backup is transactionally consistent even while WAL is in use.
python3 - "$backup" <<'PY'
import sqlite3,sys,pathlib
src=sqlite3.connect('file:/var/lib/beebots/beebots.sqlite?mode=ro',uri=True)
dest=sqlite3.connect(str(pathlib.Path(sys.argv[1])/'beebots.sqlite'))
src.backup(dest);dest.close();src.close()
PY
"$node" --input-type=module - <<'JS'
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {migrateConfig} from '/var/www/example.com/beebots/releases/2.0.0/src/migrate-v2.mjs';
import {validate} from '/var/www/example.com/beebots/releases/2.0.0/src/config.mjs';
const original=JSON.parse(readFileSync('/etc/beebots/config.json','utf8'));
const next=validate(migrateConfig(original));
writeFileSync('/etc/beebots/config.v2.tmp',JSON.stringify(next,null,2),{mode:0o640});
renameSync('/etc/beebots/config.v2.tmp','/etc/beebots/config.json');
JS
chown root:beebots /etc/beebots/config.json
install -d -m 0755 /etc/systemd/system/beebots.service.d
cat > /etc/systemd/system/beebots.service.d/release.conf <<'UNIT'
[Service]
WorkingDirectory=/var/www/example.com/beebots/releases/2.0.0
ExecStart=
ExecStart=/opt/beebots-runtime/node /var/www/example.com/beebots/releases/2.0.0/src/main.mjs
UNIT
systemctl daemon-reload
systemctl restart beebots
systemctl --no-pager status beebots
echo "Prior configuration and ledger snapshot: $backup"
echo 'Do not restore a stale ledger to roll back code after orders have occurred.'
