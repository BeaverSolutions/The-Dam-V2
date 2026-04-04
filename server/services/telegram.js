'use strict';

const https = require('https');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function apiCall(method, body) {
  return new Promise((resolve, reject) => {
    if (!TOKEN) return reject(new Error('TELEGRAM_BOT_TOKEN not set'));
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sendMessage(chatId, text, extra = {}) {
  return apiCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
}

function editMessageText(chatId, messageId, text, extra = {}) {
  return apiCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
}

function answerCallbackQuery(callbackQueryId, text = '') {
  return apiCall('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
  });
}

function sendChatAction(chatId, action = 'typing') {
  return apiCall('sendChatAction', { chat_id: chatId, action });
}

function setWebhook(url, secret) {
  return apiCall('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
  });
}

function deleteWebhook() {
  return apiCall('deleteWebhook', {});
}

module.exports = { sendMessage, editMessageText, answerCallbackQuery, sendChatAction, setWebhook, deleteWebhook };
