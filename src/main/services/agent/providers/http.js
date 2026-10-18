// One verified provider adapter: an OpenAI-compatible chat endpoint that must
// answer with a closed JSON decision. The deadline covers the response body.
// Reasoning fields are deleted before the decision is returned.
'use strict';
const { postJson, AiRequestCancelled } = require('../../ai/http');

function createHttpProvider({ endpoint, apiKey = '', model = 'default', timeoutMs = 20000, fetchImpl } = {}) {
  return {
    async next({ task, observation, signal }) {
      if (!endpoint) {
        const err = new Error('provider endpoint is not configured');
        err.code = 'UNAVAILABLE';
        throw err;
      }
      let json;
      try {
        json = await postJson({
          url: endpoint,
          label: 'agent provider',
          timeoutMs,
          signal,
          fetchImpl,
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: {
            model,
            messages: [
              { role: 'system', content: 'Return JSON only: {"type":"done","summary":"..."} or {"type":"act","operationId":"...","action":{"kind":"click"|"fill"|"press"|"select"|"check"|"navigate","ref":"...","text":"...","url":"..."}}. Never include reasoning.' },
              ...(Array.isArray(task.messages) ? task.messages.slice(-8) : []),
              { role: 'user', content: JSON.stringify({
                observationId: observation && observation.observationId,
                nodes: observation && Array.isArray(observation.nodes) ? observation.nodes.slice(0, 40) : [],
              }).slice(0, 8000) },
            ],
          },
        });
      } catch (e) {
        if (e instanceof AiRequestCancelled || (e && e.cancelled)) {
          const err = new Error('cancelled');
          err.cancelled = true;
          throw err;
        }
        if (/timed out/i.test(String(e && e.message))) {
          const err = new Error('timed out');
          err.timedOut = true;
          throw err;
        }
        throw e;
      }
      const message = json && json.choices && json.choices[0] && json.choices[0].message;
      const content = message && message.content;
      let parsed;
      try { parsed = typeof content === 'string' ? JSON.parse(content) : content; }
      catch { const err = new Error('provider response was not the closed JSON decision'); err.code = 'UNSUPPORTED'; throw err; }
      if (!parsed || typeof parsed !== 'object') throw Object.assign(new Error('empty provider decision'), { code: 'UNSUPPORTED' });
      if (Object.prototype.hasOwnProperty.call(parsed, 'reasoning')) delete parsed.reasoning;
      if (message && Object.prototype.hasOwnProperty.call(message, 'reasoning')) delete message.reasoning;
      const tokens = json && json.usage && json.usage.total_tokens;
      return { type: parsed.type, summary: parsed.summary, action: parsed.action, operationId: parsed.operationId, tokens: Number.isFinite(tokens) ? tokens : 0 };
    },
  };
}

module.exports = { createHttpProvider };
