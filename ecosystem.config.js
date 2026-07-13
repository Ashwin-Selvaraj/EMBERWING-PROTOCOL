module.exports = {
  apps: [
    {
      name: 'embr-server',
      script: 'server.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production' },
      autorestart: true,
    },
    {
      name: 'embr-listener',
      script: 'listener.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production' },
      autorestart: true,
    },
  ],
};
