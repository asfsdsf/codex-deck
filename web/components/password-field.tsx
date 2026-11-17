import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoComplete?: string;
  containerClassName?: string;
  inputClassName?: string;
  disabled?: boolean;
}

export default function PasswordField(props: PasswordFieldProps) {
  const {
    label,
    value,
    onChange,
    placeholder,
    autoComplete,
    containerClassName = "block space-y-1",
    inputClassName = "w-full rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 pr-12 text-sm text-zinc-100 focus:outline-none",
    disabled = false,
  } = props;
  const [visible, setVisible] = useState(false);

  return (
    <label className={containerClassName}>
      <span className="text-xs text-zinc-500">{label}</span>
      <div className="relative">
        <input
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          disabled={disabled}
          className={inputClassName}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 transition-colors hover:text-zinc-200"
          aria-label={visible ? `Hide ${label}` : `Show ${label}`}
          title={visible ? "Hide password" : "Show password"}
        >
          {visible ? (
            <EyeOff className="h-4 w-4" />
          ) : (
            <Eye className="h-4 w-4" />
          )}
        </button>
      </div>
    </label>
  );
}
