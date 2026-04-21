module.exports = {
  apps: [
    {
      name: "box-daemon",
      script: "src/cli.ts",
      args: "start",
      cwd: "C:\\Users\\caner\\Desktop\\Box",
      interpreter: "node",
      interpreter_args: "--import tsx",
      autorestart: true,         // restart if daemon crashes unexpectedly
      restart_delay: 5000,       // wait 5s before restarting
      max_restarts: 10,
      watch: false,
      max_memory_restart: "2G",
      env_file: ".env",
      log_file: "logs/daemon.log",
      out_file: "logs/daemon-out.log",
      error_file: "logs/daemon-err.log",
      time: true
    }
  ]
};
