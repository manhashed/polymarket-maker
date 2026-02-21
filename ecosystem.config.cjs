module.exports = {
  apps: [
    {
      name: 'polymarket-maker',
      script: 'dist/index.js',
      node_args: '--max-old-space-size=512',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',
      error_file: '/var/log/polymarket-maker/error.log',
      out_file: '/var/log/polymarket-maker/out.log',
      merge_logs: true,
    },
  ],
};
