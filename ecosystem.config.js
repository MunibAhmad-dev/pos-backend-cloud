module.exports = {
  apps: [
    {
      name:               'pos-backend',
      script:             'dist/index.js',
      instances:          1,
      exec_mode:          'fork',
      autorestart:        true,
      watch:              false,
      max_memory_restart: '400M',

      // Env vars are read from the .env file via dotenv in the app itself.
      // Only set NODE_ENV here so the app knows it is production.
      env_production: {
        NODE_ENV: 'production',
      },

      // Logging
      error_file:   'logs/err.log',
      out_file:     'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:   true,
    },
  ],
};
