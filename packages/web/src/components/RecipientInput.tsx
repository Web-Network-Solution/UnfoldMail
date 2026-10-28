import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { contactsApi } from "../lib/api";
import { useAuthStore } from "../stores";

export default function RecipientInput({
  id,
  value,
  onChange,
  placeholder = "Name or email address",
  required = false,
  invalid = false,
  describedBy,
}: {
  id?: string;
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const uid = useId(),
    listId = `recipients-${uid}`,
    user = useAuthStore((s) => s.user?.id);
  const [focused, setFocused] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(-1);
  const term = value.split(/[,;]/).pop()?.trim() || "";
  useEffect(() => {
    setActive(-1);
    const t = setTimeout(() => setQuery(term), 200);
    return () => clearTimeout(t);
  }, [term]);
  const { data } = useQuery({
    queryKey: ["contact-suggestions", user, query],
    queryFn: () => contactsApi.suggest(query),
    enabled: focused && query.length > 0,
    staleTime: 30000,
  });
  const results = query === term ? data?.data || [] : [],
    open = focused && results.length > 0;
  function choose(email: string) {
    const parts = value.split(/[,;]/);
    parts.pop();
    onChange(
      [...parts.map((p) => p.trim()).filter(Boolean), email, ""].join(", "),
    );
    setActive(-1);
  }
  return (
    <div className="recipient-input">
      <input
        id={id}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        value={value}
        required={required}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            setFocused(false);
            e.stopPropagation();
          }
          if (open && e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => (a + 1) % results.length);
          }
          if (open && e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a - 1 + results.length) % results.length);
          }
          if (open && e.key === "Enter" && active >= 0) {
            e.preventDefault();
            choose(results[active].email);
          }
        }}
      />
      {open && (
        <div id={listId} role="listbox" className="recipient-options">
          {results.map((r, i) => (
            <button
              type="button"
              role="option"
              aria-selected={active === i}
              id={`${listId}-${i}`}
              key={r.email}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(r.email)}
            >
              <strong>{r.name}</strong>
              <span>{r.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
