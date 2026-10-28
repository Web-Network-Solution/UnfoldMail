import { Children, Fragment, isValidElement, useRef, useState, type ReactNode, type ComponentPropsWithoutRef } from 'react';
import * as Primitive from '@radix-ui/react-select';

type OptionProps = { value?: string | number; disabled?: boolean; children?: ReactNode };
/** Declarative option data. Rendering and keyboard handling belong to Select. */
export function SelectOption(_props: OptionProps) { return null; }
function options(children: ReactNode): OptionProps[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<OptionProps>(child)) return [];
    if (child.type === Fragment) return options(child.props.children);
    return child.type === SelectOption ? [child.props] : [];
  });
}
type Props = Omit<ComponentPropsWithoutRef<typeof Primitive.Trigger>, 'value' | 'onChange' | 'children'> & {
  value: string | number; onValueChange: (value: string) => void; children: ReactNode; name?: string; required?: boolean;
};
export default function Select({ value, onValueChange, children, name, required, disabled, className = '', ...props }: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const items = options(children);
  // Prefix every value so the empty-string option remains selectable.
  const encode = (v: string | number) => `option:${v}`;
  return <Primitive.Root value={encode(value)} onValueChange={v => onValueChange(v.slice(7))} open={open} onOpenChange={setOpen} disabled={disabled}>
    {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
    <Primitive.Trigger {...props} ref={trigger} type="button" aria-required={required || undefined} className={`ui-select-trigger ${className}`}>
      <Primitive.Value /><Primitive.Icon className="ui-select-chevron" aria-hidden>⌄</Primitive.Icon>
    </Primitive.Trigger>
    <Primitive.Portal container={trigger.current?.closest('dialog, [role="dialog"]') as HTMLElement | undefined}>
      <Primitive.Content className="ui-select-content" position="popper" sideOffset={6} collisionPadding={12} onEscapeKeyDown={e => e.stopPropagation()}>
        <Primitive.ScrollUpButton className="ui-select-scroll" aria-label="Scroll up">⌃</Primitive.ScrollUpButton>
        <Primitive.Viewport className="ui-select-viewport">
          {items.map(item => { const raw = item.value ?? String(item.children ?? ''); return <Primitive.Item className="ui-select-option" key={raw} value={encode(raw)} disabled={item.disabled}>
            <Primitive.ItemText>{item.children}</Primitive.ItemText><Primitive.ItemIndicator className="ui-select-check" aria-hidden>✓</Primitive.ItemIndicator>
          </Primitive.Item>; })}
        </Primitive.Viewport>
        <Primitive.ScrollDownButton className="ui-select-scroll" aria-label="Scroll down">⌄</Primitive.ScrollDownButton>
      </Primitive.Content>
    </Primitive.Portal>
  </Primitive.Root>;
}
