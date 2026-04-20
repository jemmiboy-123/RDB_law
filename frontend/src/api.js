export async function api(path, options = {}) {
  const { method = "GET", data, formData } = options;
  const init = { method, credentials: "include", headers: {} };

  if (data) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(data);
  }
  if (formData) {
    init.body = formData;
  }

  const response = await fetch(path, init);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : null;

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return payload;
}
