export function Avatar({ name, hue, size = 44 }: { name: string; hue: number; size?: number }) {
  const initials = name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div
      className="flex items-center justify-center rounded-full font-semibold text-white shadow-sm"
      style={{
        width: size, height: size, fontSize: size * 0.36,
        background: `linear-gradient(135deg, hsl(${hue} 45% 52%), hsl(${(hue + 40) % 360} 50% 42%))`,
      }}
      aria-hidden
    >
      {initials}
    </div>
  );
}
