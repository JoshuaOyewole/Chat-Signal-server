const http = require('http');
const { attachWsServer } = require('./wsServer');
const logger = require('./logger');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

attachWsServer(server);

server.listen(PORT, () => {
  logger.log(`Signaling server listening on port ${PORT}`);
});
