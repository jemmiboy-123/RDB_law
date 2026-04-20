export function fmtDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}
