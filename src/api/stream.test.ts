import { Client } from 'pg';
import { setupSSE, sseClients } from './stream';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';

// Mock pg.Client
jest.mock('pg', () => {
  const mockClient = {
    connect: jest.fn(),
    query: jest.fn(),
    on: jest.fn(),
    end: jest.fn(),
    emit: jest.fn(),
  };
  return { Client: jest.fn(() => mockClient) };
});

const mockClient = new Client();
const mockedClient = mockClient as jest.Mocked<Client>;

describe('stream.ts', () => {
  let server: Server;
  let port: number;

  beforeAll(() => {
    server = createServer();
    setupSSE(server);
    server.listen(0);
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
    sseClients.clear();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    sseClients.clear();
  });

  it('should handle database disconnection gracefully', (done) => {
    // Simulate error event on LISTEN client
    mockedClient.emit('error', new Error('Database connection lost'));

    // Verify error handler was called
    expect(mockedClient.on).toHaveBeenCalledWith('error', expect.any(Function));

    // Verify reconnect was scheduled
    setTimeout(() => {
      expect(mockedClient.connect).toHaveBeenCalled();
      done();
    }, 6000); // Slightly longer than reconnect delay
  });

  it('should broadcast disconnect to SSE clients', (done) => {
    const testClientId = 'test-client';
    const mockResponse = {
      write: jest.fn(),
    } as unknown as ServerResponse;

    sseClients.set(testClientId, {
      id: testClientId,
      response: mockResponse,
      isConnected: true,
    });

    mockedClient.emit('error', new Error('Database connection lost'));

    setTimeout(() => {
      expect(mockResponse.write).toHaveBeenCalledWith(
        expect.stringContaining('DATABASE_DISCONNECT')
      );
      done();
    }, 100);
  });

  it('should handle LISTEN client end event', () => {
    mockedClient.emit('end');
    expect(mockedClient.on).toHaveBeenCalledWith('end', expect.any(Function));
  });
});
