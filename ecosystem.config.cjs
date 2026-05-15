// PM2 config for grokscope. Run from the repo root: `pm2 start ecosystem.config.cjs`.
const path = require('node:path');
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: 'grokscope-api',
      script: 'server/index.js',
      cwd: ROOT,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 1500,
      exp_backoff_restart_delay: 200,
      out_file: path.join(ROOT, '.logs/api.out.log'),
      error_file: path.join(ROOT, '.logs/api.err.log'),
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        PORT: process.env.GROKSCOPE_API_PORT || '7778',
      },
    },
    {
      name: 'grokscope-web',
      script: 'npm',
      args: 'run dev',
      cwd: ROOT,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 1500,
      exp_backoff_restart_delay: 200,
      out_file: path.join(ROOT, '.logs/web.out.log'),
      error_file: path.join(ROOT, '.logs/web.err.log'),
      merge_logs: true,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
