import fs from 'fs';
import path from 'path';
import net from 'net';
import tls from 'tls';

interface Options {
  host: string;
  port: number;
  out: string;
  timeoutMs: number;
}

const defaultOptions: Options = {
  host: '192.168.1.10',
  port: 443,
  out: path.resolve('data', 'plc-cert-chain.pem'),
  timeoutMs: 5000,
};

function parseArgs(argv: string[]): Options {
  const opts: Options = { ...defaultOptions };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host' && argv[i + 1]) {
      opts.host = argv[++i];
    } else if (arg === '--port' && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (arg === '--out' && argv[i + 1]) {
      opts.out = path.resolve(argv[++i]);
    } else if (arg === '--timeout' && argv[i + 1]) {
      opts.timeoutMs = Number(argv[++i]);
    }
  }
  return opts;
}

function pemFromDer(der: Buffer): string {
  const base64 = der.toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function collectChain(peer: tls.DetailedPeerCertificate): tls.DetailedPeerCertificate[] {
  const chain: tls.DetailedPeerCertificate[] = [];
  const seen = new Set<string>();
  let current: tls.DetailedPeerCertificate | undefined = peer;

  while (current && current.raw && !seen.has(current.fingerprint256)) {
    chain.push(current);
    seen.add(current.fingerprint256);
    if (!current.issuerCertificate || current.issuerCertificate === current) break;
    current = current.issuerCertificate as tls.DetailedPeerCertificate;
  }

  return chain;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  await new Promise<void>((resolve, reject) => {
    const servername = net.isIP(opts.host) ? undefined : opts.host;
    const socket = tls.connect({
      host: opts.host,
      port: opts.port,
      servername,
      rejectUnauthorized: false,
      timeout: opts.timeoutMs,
    }, () => {
      try {
        const peer = socket.getPeerCertificate(true) as tls.DetailedPeerCertificate;
        if (!peer || !peer.raw) {
          throw new Error('No peer certificate received');
        }

        const chain = collectChain(peer);
        const pem = chain.map(cert => pemFromDer(cert.raw)).join('');

        fs.mkdirSync(path.dirname(opts.out), { recursive: true });
        fs.writeFileSync(opts.out, pem, 'utf8');
        console.log(`Saved ${chain.length} certificate(s) to ${opts.out}`);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        socket.end();
      }
    });

    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`TLS connection timed out after ${opts.timeoutMs}ms`));
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
