'use strict';
const cfg = require('./config');
const { createServer } = require('./server');

const server = createServer();
server.listen(cfg.PORT, cfg.HOST, () => {
  console.log(`[werkos] Server läuft auf http://${cfg.HOST}:${cfg.PORT}`);
  console.log(`[werkos] Datenverzeichnis: ${cfg.DATA_DIR}`);
  console.log(`[werkos] Admin-API: ${cfg.ADMIN_TOKEN ? 'aktiv' : 'deaktiviert (WERKOS_ADMIN_TOKEN setzen)'}`);
});
