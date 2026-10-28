import Select, { SelectOption } from '../components/ui/Select';
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Contact, ContactInput } from "@email-service/shared";
import { contactsApi, downloadProductivity } from "../lib/api";
import { useAuthStore, useMailStore, useToastStore } from "../stores";
import ProductivityDialog from "../components/ProductivityDialog";
import { IconMail, IconSearch, IconUsers } from "../components/Icons";

const blank: ContactInput = {
  name: "",
  email: "",
  phone: "",
  company: "",
  notes: "",
  groups: [],
};
export default function Contacts() {
  const user = useAuthStore((s) => s.user),
    toast = useToastStore((s) => s.addToast),
    cache = useQueryClient(),
    file = useRef<HTMLInputElement>(null),
    openCompose = useMailStore((s) => s.openCompose);
  const [mode, setMode] = useState<"personal" | "directory">("personal"),
    [query, setQuery] = useState(""),
    [group, setGroup] = useState(""),
    [page, setPage] = useState(0),
    [editor, setEditor] = useState<
      (ContactInput & { id?: string; revision?: number }) | null
    >(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [groupText, setGroupText] = useState("");
  const personal = useQuery({
    queryKey: ["contacts", user?.id, query, group, page],
    queryFn: () => contactsApi.list(query, group, page),
    enabled: mode === "personal",
  });
  const directory = useQuery({
    queryKey: ["directory", user?.id, query, page],
    queryFn: () => contactsApi.directory(query, page),
    enabled: mode === "directory",
  });
  const current = mode === "personal" ? personal : directory,
    contacts = current.data?.data?.contacts || [];
  const refresh = () => {
    cache.invalidateQueries({ queryKey: ["contacts"] });
    cache.invalidateQueries({ queryKey: ["contact-suggestions"] });
  };
  const fail = (e: unknown) =>
    toast({
      type: "error",
      title: "Contacts",
      body: e instanceof Error ? e.message : "Operation failed",
    });
  function edit(c: ContactInput & { id?: string; revision?: number }) {
    setError("");
    setEditor({ ...c });
    setGroupText(c.groups.join(", "));
  }
  async function remove(c: Contact) {
    if (!confirm(`Delete ${c.name} from your contacts?`)) return;
    try {
      await contactsApi.delete(c.id);
    } catch (e) {
      fail(e);
    }
    refresh(); // A contact removed elsewhere (404) should also leave the list.
  }
  async function importFile(f: File) {
    if (f.size > 1024 * 1024) {
      fail(new Error("Choose a file under 1 MB"));
      return;
    }
    setBusy(true);
    try {
      const r = await contactsApi.import(
        await f.text(),
        /\.vcf$/i.test(f.name) ? "vcf" : "csv",
      );
      refresh();
      toast({
        type: "success",
        title: "Contacts imported",
        body: `${r.data?.imported} added; ${r.data?.skipped} existing addresses skipped.`,
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="productivity-page">
      <header className="productivity-heading">
        <div>
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h1>Contacts</h1>
          <p>The people you work with, all in one place.</p>
        </div>
        <button className="btn btn-primary" onClick={() => edit(blank)}>
          + New contact
        </button>
      </header>
      <div className="productivity-toolbar">
        <div className="segmented-control">
          <button
            className={mode === "personal" ? "active" : ""}
            onClick={() => {
              setMode("personal");
              setPage(0);
            }}
          >
            My contacts
          </button>
          <button
            className={mode === "directory" ? "active" : ""}
            onClick={() => {
              setMode("directory");
              setPage(0);
            }}
          >
            Employee directory
          </button>
        </div>
        <div className="productivity-search">
          <IconSearch size={17} />
          <input
            aria-label="Search contacts"
            placeholder="Search people or companies"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </div>
      </div>
      {mode === "personal" && (
        <div className="productivity-toolbar">
          <Select
            className="form-input"
            aria-label="Contact group"
            value={group}
            onValueChange={selectedValue => {
              setGroup(selectedValue);
              setPage(0);
            }}
          >
            <SelectOption value="">All groups</SelectOption>
            {personal.data?.data?.groups.map((g) => (
              <SelectOption key={g}>{g}</SelectOption>
            ))}
          </Select>
          <div className="productivity-actions">
            <input
              ref={file}
              type="file"
              accept=".csv,.vcf"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = "";
              }}
            />
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => file.current?.click()}
            >
              {busy ? "Importing…" : "Import contacts"}
            </button>
            {(["csv", "vcf"] as const).map((f) => (
              <button
                key={f}
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  downloadProductivity(
                    `/contacts/export?format=${f}`,
                    `contacts.${f}`,
                  ).catch(fail)
                }
              >
                Export {f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      )}
      {mode === "directory" && (
        <p className="productivity-note">
          Employees are maintained by your administrator. Save a person to add
          private notes or groups.
        </p>
      )}
      {current.isLoading ? (
        <div className="productivity-empty" role="status">
          Loading contacts…
        </div>
      ) : current.isError ? (
        <div className="productivity-empty" role="alert">
          <p>{current.error.message}</p>
          <button
            className="btn btn-secondary"
            onClick={() => current.refetch()}
          >
            Try again
          </button>
        </div>
      ) : !contacts.length ? (
        <div className="productivity-empty">
          <IconUsers size={38} />
          <h2>
            {query || group
              ? "No matching people"
              : "Your address book starts here"}
          </h2>
          <p>
            {query || group
              ? "Try another search or group."
              : "Add a contact or import a CSV/vCard file. CSV columns: name, email, phone, company, notes, groups."}
          </p>
        </div>
      ) : (
        <div className="contacts-grid">
          {contacts.map((c) => (
            <article className="contact-card" key={c.id}>
              <div className="contact-avatar">
                {c.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="contact-info">
                <h2>{c.name}</h2>
                <p>{c.email}</p>
                {c.company && <p>{c.company}</p>}
                {c.phone && <p>{c.phone}</p>}
                <div className="contact-tags">
                  {c.groups.map((g) => (
                    <span key={g}>{g}</span>
                  ))}
                </div>
              </div>
              <div className="contact-card-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => openCompose({ to: c.email })}
                >
                  <IconMail size={15} /> Email
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    edit(
                      c.directory
                        ? { ...c, id: undefined, revision: undefined }
                        : c,
                    )
                  }
                >
                  {c.directory ? "Save contact" : "Edit"}
                </button>
                {!c.directory && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => remove(c)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <footer className="productivity-pagination">
        <span>
          {mode === "personal"
            ? `${personal.data?.data?.total || 0} contacts`
            : "Employee directory"}{" "}
          · Page {page + 1}
        </span>
        <button
          className="btn btn-ghost btn-sm"
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={
            mode === "personal"
              ? (page + 1) * 100 >= (personal.data?.data?.total || 0)
              : !directory.data?.data?.hasMore
          }
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </footer>
      {editor && (
        <ProductivityDialog
          title={editor.id ? "Edit contact" : "New contact"}
          onClose={() => {
            if (!busy) setEditor(null);
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await contactsApi.save({
                  ...editor,
                  groups: groupText
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                });
                refresh();
                setEditor(null);
                toast({ type: "success", title: "Contact saved" });
              } catch (err) {
                setError(err instanceof Error ? err.message : "Unable to save");
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="productivity-form">
              {(["name", "email", "phone", "company"] as const).map((k) => (
                <label key={k}>
                  {k[0].toUpperCase() + k.slice(1)}
                  <input
                    className="form-input"
                    type={k === "email" ? "email" : "text"}
                    required={k === "name" || k === "email"}
                    maxLength={k === "email" ? 254 : k === "phone" ? 80 : 160}
                    value={editor[k]}
                    onChange={(e) =>
                      setEditor({ ...editor, [k]: e.target.value })
                    }
                  />
                </label>
              ))}
              <label className="full-width">
                Groups{" "}
                <input
                  className="form-input"
                  placeholder="Finance, Vendors"
                  value={groupText}
                  onChange={(e) => setGroupText(e.target.value)}
                />
              </label>
              <label className="full-width">
                Private notes
                <textarea
                  className="form-input"
                  rows={4}
                  maxLength={4000}
                  value={editor.notes}
                  onChange={(e) =>
                    setEditor({ ...editor, notes: e.target.value })
                  }
                />
              </label>
              {error && (
                <p className="form-error full-width" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => setEditor(null)}
              >
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy}>
                {busy ? "Saving…" : "Save contact"}
              </button>
            </footer>
          </form>
        </ProductivityDialog>
      )}
    </section>
  );
}
