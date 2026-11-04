// Monta o DiscordIA.exe. Uso: node empacotar.mjs <pasta-de-saida>
import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || path.join(dir, 'dist'));

const paths = await packager({
  dir,
  out,
  name: 'DiscordIA',
  platform: 'win32',
  arch: 'x64',
  icon: path.join(dir, 'build', 'icon.ico'),
  overwrite: true,
  prune: true,
  // caminhos relativos à pasta desktop, sempre com "/" (o empacotador normaliza no Windows)
  ignore: [
    /^\/dist(\/|$)/,              // builds antigos
    /^\/build\/icon\.png$/,       // só o .ico vai no app
    /^\/empacotar\.mjs$/,
  ],
  appCopyright: 'DiscordIA',
  win32metadata: { ProductName: 'DiscordIA', FileDescription: 'DiscordIA', CompanyName: 'DiscordIA' },
});

console.log('App montado em:', paths.join(', '));
