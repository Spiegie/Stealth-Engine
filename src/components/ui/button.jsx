import React from "react";

const variants = {
  default: "bg-stone-200 text-stone-900 hover:bg-stone-300",
  outline:
    "border border-stone-600 bg-transparent text-stone-200 hover:bg-stone-800",
};

export function Button({
  variant = "default",
  size = "default",
  className = "",
  ...props
}) {
  const v = variants[variant] ?? variants.default;
  const s = size === "sm" ? "h-8 px-3 text-xs" : "h-9 px-4 text-sm";
  return (
    <button
      className={
        "inline-flex select-none items-center justify-center gap-2 rounded-md font-medium transition-colors " +
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 " +
        "disabled:pointer-events-none disabled:opacity-50 " +
        v +
        " " +
        s +
        " " +
        className
      }
      {...props}
    />
  );
}

export default Button;
