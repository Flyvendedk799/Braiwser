// JSON exporter — emits the full session + annotations payload as
// pretty-printed JSON, suitable for archival or re-import. Pure function.

function toJson(session, annotations) {
  const payload = {
    session: session || null,
    annotations: Array.isArray(annotations) ? annotations : [],
    exportedAt: new Date().toISOString(),
  };
  return JSON.stringify(payload, null, 2);
}

module.exports = { toJson };
