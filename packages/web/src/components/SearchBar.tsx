import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchApi } from '../lib/api';
import { useMailStore } from '../stores';
import type { SearchResult } from '@email-service/shared';
import { IconSearch, IconArchive } from './Icons';

export default function SearchBar() {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  // Defaults to true, matching the API and the requirement that archived mail
  // stays searchable. Unticking narrows the search to non-archived mail.
  const [includeArchived, setIncludeArchived] = useState(true);
  // Trash is excluded by default, as in the API (and Gmail).
  const [includeTrash, setIncludeTrash] = useState(false);
  const { setSelectedEmail, activeFolder } = useMailStore();
  // Searching from the Trash view must find what that view lists.
  const inTrash = activeFolder?.type === 'trash';
  const trash = includeTrash || inTrash;

  const { data, isLoading } = useQuery({
    queryKey: ['search', query, includeArchived, trash],
    queryFn: () => searchApi.search({ q: query, includeArchived, includeTrash: trash }),
    enabled: query.length >= 2 && isOpen,
    staleTime: 10_000,
  });

  const handleSelect = useCallback(
    (result: SearchResult) => {
      setSelectedEmail(result.id);
      setIsOpen(false);
      setQuery('');
    },
    [setSelectedEmail]
  );

  return (
    <>
      <form id="mailbox-search-form" role="search" className="search-container" autoComplete="off" onSubmit={(e) => e.preventDefault()}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsOpen(false); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.querySelector('input')?.focus(); setIsOpen(false); } }}>

        <span className="search-icon"><IconSearch size={16} /></span>
        <input
          className="search-input"
          id="mailbox-search"
          name="mailbox-query"
          type="search"
          autoComplete="off"
          aria-label="Search mail"
          placeholder="Search emails..."
          value={query}
          onChange={(e) => {
            // Browser profile autofill must not change a background search when
            // the user is choosing a recipient in the composer.
            if (document.activeElement !== e.currentTarget) {
              e.currentTarget.value = query;
              return;
            }
            setQuery(e.target.value);
            setIsOpen(e.target.value.length >= 2);
          }}
          onFocus={() => query.length >= 2 && setIsOpen(true)}
        />

        {/* Search Results Dropdown */}
        {isOpen && query.length >= 2 && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              marginTop: 4,
              background: 'var(--color-bg-elevated)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-lg)',
              maxHeight: 400,
              overflowY: 'auto',
              zIndex: 100,
            }}
          >
            {/* Include archived / Trash toggles */}
            <div style={{
              padding: 'var(--space-2) var(--space-3)',
              borderBottom: '1px solid var(--color-border)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-text-tertiary)',
            }}>
              {/* onMouseDown preventDefault: the input blur handler closes this dropdown,

                  and clicking the checkbox blurred the input before the change landed. */}

              <label

                style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}

                onMouseDown={(e) => e.preventDefault()}

              >
                <input
                  type="checkbox"
                  checked={includeArchived}
                  onChange={(e) => setIncludeArchived(e.target.checked)}
                />
                Include archived
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} onMouseDown={(e) => e.preventDefault()}>
                <input
                  type="checkbox"
                  checked={trash}
                  disabled={inTrash}
                  onChange={(e) => setIncludeTrash(e.target.checked)}
                />
                Include Trash
              </label>
            </div>

            {isLoading && (
              <div style={{ padding: 'var(--space-4)', textAlign: 'center' }}>
                <span className="loading-spinner" />
              </div>
            )}

            {data?.data?.map((result: SearchResult) => (
              <button
                type="button"
                className="search-result-item"
                key={result.id}
                style={{
                  padding: 'var(--space-3) var(--space-4)',
                  cursor: 'pointer',
                  borderBottom: '1px solid var(--color-border)',
                  transition: 'background var(--transition-fast)',
                }}
                onClick={() => handleSelect(result)}
              >
                <div style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', marginBottom: 2 }}>
                  {result.subject || '(no subject)'}
                </div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)' }}>
                  {result.sender} • {new Date(result.receivedAt).toLocaleDateString()}
                  {result.isArchived && (
                    <span style={{ marginLeft: 8, color: 'var(--color-warning)', fontSize: 'var(--font-size-xs)' }}>
                      <IconArchive size={12} /> Archived
                    </span>
                  )}
                </div>
              </button>
            ))}

            {data?.data?.length === 0 && !isLoading && (
              <div style={{
                padding: 'var(--space-4)',
                textAlign: 'center',
                color: 'var(--color-text-tertiary)',
                fontSize: 'var(--font-size-sm)',
              }}>
                No results found for "{query}"
              </div>
            )}
          </div>
        )}
      </form>
    </>
  );
}
