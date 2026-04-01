'use strict';

const logger = {
  info: (data) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), ...data })),
  error: (data) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), ...data })),
  warn: (data) => console.warn(JSON.stringify({ level: 'warn', timestamp: new Date().toISOString(), ...data })),
};

module.exports = logger;
