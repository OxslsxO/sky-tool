module.exports = {
  apps: [
    {
      name: "sky-toolbox-backend",
      script: "./backend/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        PORT: 3100,
      },
    },
  ],
};
