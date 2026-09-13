#!/bin/bash
# deploy.sh — actualizar y relanzar el generador de viajes
set -e

cd "$(dirname "$0")"

echo "== Trayendo cambios de git =="
pm2 stop creadorviajes
git checkout -- db/viajes.db-wal db/viajes.db-shm 2>/dev/null || true
git pull

echo "== Instalando dependencias (solo si hay cambios) =="
npm install
rm -f db/viajes.db-wal db/viajes.db-shm
echo "== Reiniciando la app en pm2 =="
pm2 restart creadorviajes --update-env

echo "== Estado =="
pm2 status creadorviajes
pm2 logs creadorviajes --lines 10 --nostream

echo ""
echo "✓ Desplegado. Comprueba: https://viajes.es-consultingdream.uk"
