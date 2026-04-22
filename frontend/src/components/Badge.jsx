import React from "react";
function Badge({ value, label }) {
  return (
    <span className={`badge badge-${value}`}>
      {label ?? value?.replace(/_/g, " ")}
    </span>
  );
}
export default Badge;
