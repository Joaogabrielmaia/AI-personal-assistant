#!/bin/sh
# Cópia diária do banco (rode no cron: 0 4 * * * /opt/assistente/deploy/backup.sh)
set -e
cd /opt/assistente
mkdir -p backups
sqlite3 data/assistente.db ".backup 'backups/assistente-$(date +%F).db'"
find backups -name 'assistente-*.db' -mtime +14 -delete
