import React from "react";

const base =
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors";

export function Badge({ className = "", ...props }) {
  return <span className={base + " " + className} {...props} />;
}

export default Badge;
