import { Client } from 'pg';
import { Server } from 'http';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

interface StreamClient {
  id: string;
  response: ServerResponse;
  isConnected: boolean;
}

const sseClients = new Map<string, StreamClient>();
const listenClient = new Client({
  connectionString: process.env.DATABASE_URL,
});

let isReconnecting = false;

// Dedicated LISTEN client for PostgreSQL notifications
function setupListenClient() {
  listenClient.connect().catch((err) => {
    console.error('LISTEN client connection error:', err);
    scheduleReconnect();
  });

  listenClient.on('error', (err) => {
    console.error('LISTEN client error:', err);
    broadcastDisconnect();
    scheduleReconnect();
  });

  listenClient.on('end', () => {
    console.log('LISTEN client disconnected');
    broadcastDisconnect();
    scheduleReconnect();
  });

  listenClient.query('LISTEN new_event').catch((err) => {
    console.error('Failed to LISTEN for notifications:', err);
  });
}

function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  const delay = 5000; // 5 seconds
  console.log(`Attempting to reconnect LISTEN client in ${delay}ms...`);
  setTimeout(() => {
    isReconnecting = false;
    setupListenClient();
  }, delay);
}

function broadcastDisconnect() {
  const message = JSON.stringify({
    type: 'DATABASE_DISCONNECT',
    message: 'Database connection lost. Reconnecting...',
  });
  sseClients.forEach((client) => {
    if (client.isConnected) {
      client.response.write(`data: ${message}\n\n`);
    }
  });
}

function setupSSE(server: Server) {
  server.on('request', (req, res) => {
    if (req.url === '/stream') {
      const clientId = uuidv4();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('retry: 5000\n\n');

      const streamClient: StreamClient = {
        id: clientId,
        response: res,
        isConnected: true,
      };
      sseClients.set(clientId, streamClient);

      req.on('close', () => {
        sseClients.delete(clientId);
        streamClient.isConnected = false;
      });
    }
  });
}

// Initialize
setupListenClient();

// Handle notifications
listenClient.on('notification', (msg) => {
  const message = JSON.stringify({
    type: 'EVENT',
    payload: msg.payload,
  });
  sseClients.forEach((client) => {
    if (client.isConnected) {
      client.response.write(`data: ${message}\n\n`);
    }
  });
});

export { setupSSE, sseClients };
