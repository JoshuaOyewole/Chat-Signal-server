const http = require('http');
const express = require('express');
const { attachWsServer } = require('./wsServer');
const authRouter = require('./routes/auth');
const logger = require('./logger');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

app.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
});

app.use('/auth', authRouter);

const server = http.createServer(app);
attachWsServer(server);

server.listen(PORT, () => {
  logger.log(`Signaling server listening on port ${PORT}`);
});
