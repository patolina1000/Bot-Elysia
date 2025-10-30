import 'dotenv/config';

type NodeEnv = 'development' | 'production';

function getEnv(name: string, fallback?: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    if (typeof fallback !== 'undefined') {
      console.warn(`[env] ${name} não definido, usando fallback: ${fallback}`);
      return fallback;
    }
    console.warn(`[env] ${name} não definido e não há fallback, retornando string vazia.`);
    return '';
  }
  return value;
}

const portStr = getEnv('PORT', '8080');
let port = Number.parseInt(portStr, 10);
if (Number.isNaN(port)) {
  console.warn(`[env] PORT inválido (${portStr}), usando 8080`);
  port = 8080;
}

const appBaseUrlStr = getEnv('APP_BASE_URL', 'http://localhost:3000');

let appBaseUrl: URL;
try {
  appBaseUrl = new URL(appBaseUrlStr);
} catch (err) {
  console.warn(`[env] APP_BASE_URL inválido (${appBaseUrlStr}), usando http://localhost:3000`);
  appBaseUrl = new URL('http://localhost:3000');
}

const databaseUrl = getEnv('DATABASE_URL', '');
if (!databaseUrl) {
  console.warn('[env] DATABASE_URL está vazio! Em produção isso deve estar definido.');
}

const adminApiToken = getEnv('ADMIN_API_TOKEN', '');
if (!adminApiToken) {
  console.warn('[env] ADMIN_API_TOKEN está vazio! Rotas /admin vão recusar sem isso.');
}

const encryptionKey = getEnv('ENCRYPTION_KEY', '');
if (!encryptionKey) {
  console.warn('[env] ENCRYPTION_KEY está vazio! Recursos de criptografia podem falhar.');
}

const nodeEnvRaw = getEnv('NODE_ENV', 'production').toLowerCase();
let nodeEnv: NodeEnv = 'production';
if (nodeEnvRaw === 'development' || nodeEnvRaw === 'production') {
  nodeEnv = nodeEnvRaw;
} else {
  console.warn(`[env] NODE_ENV inválido (${nodeEnvRaw}), usando production`);
}

export const env = {
  appBaseUrl,
  appBaseUrlStr,
  databaseUrl,
  adminApiToken,
  encryptionKey,
  nodeEnv,
  port,
  APP_BASE_URL: appBaseUrlStr,
  DATABASE_URL: databaseUrl,
  ADMIN_API_TOKEN: adminApiToken,
  ENCRYPTION_KEY: encryptionKey,
  NODE_ENV: nodeEnv,
  PORT: port,
};

