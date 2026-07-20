import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type MutableRefObject,
  type ReactNode,
  type RefCallback,
  type SyntheticEvent,
} from 'react'
import styles from './sortable-list.module.css'

const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, [contenteditable="true"]'

export interface SortableRenderState {
  active: boolean
  dragging: boolean
  overlay: boolean
  activatorProps: HTMLAttributes<HTMLElement> & { ref: RefCallback<HTMLElement> }
}

interface SortableListProps<T extends { id: string }> {
  items: T[]
  disabled?: boolean
  activator?: 'item' | 'child'
  className?: string
  label: (item: T) => string
  onReorder: (items: T[]) => Promise<void> | void
  children: (item: T, state: SortableRenderState) => ReactNode
}

export function SortableList<T extends { id: string }>({
  items,
  disabled = false,
  activator = 'item',
  className = '',
  label,
  onReorder,
  children,
}: SortableListProps<T>) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overlayWidth, setOverlayWidth] = useState<number | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [saving, setSaving] = useState(false)
  const suppressClick = useRef(false)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const activeItem = useMemo(
    () => items.find((item) => item.id === activeId) ?? null,
    [activeId, items],
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const itemLabel = (id: string | number) => {
    const item = items.find((candidate) => candidate.id === id)
    return item ? label(item) : String(id)
  }

  const finishDrag = async ({ active, over }: DragEndEvent) => {
    setActiveId(null)
    suppressClick.current = true
    window.setTimeout(() => {
      suppressClick.current = false
    }, 0)
    if (!over || active.id === over.id) return
    const from = items.findIndex((item) => item.id === active.id)
    const to = items.findIndex((item) => item.id === over.id)
    if (from < 0 || to < 0) return
    setSaving(true)
    try {
      await onReorder(arrayMove(items, from, to))
    } catch (err) {
      console.error({ err }, 'Failed to reorder sortable list')
    } finally {
      setSaving(false)
    }
  }

  const listDisabled = disabled || saving || items.length < 2
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `已拾取 ${itemLabel(active.id)}`,
          onDragOver: ({ over }) => (over ? `移动到 ${String(over.id)}` : '移出排序列表'),
          onDragEnd: ({ over }) => (over ? `已放置到 ${String(over.id)}` : '排序已取消'),
          onDragCancel: () => '排序已取消',
        },
      }}
      onDragStart={(event: DragStartEvent) => {
        setActiveId(String(event.active.id))
        setOverlayWidth(event.active.rect.current.initial?.width ?? null)
      }}
      onDragCancel={() => {
        setActiveId(null)
        setOverlayWidth(null)
      }}
      onDragEnd={(event) => void finishDrag(event)}
    >
      <div
        className={`${styles.list} ${className}`}
        data-saving={saving || undefined}
        data-disabled={listDisabled || undefined}
      >
        <SortableContext
          items={items.map((item) => item.id)}
          strategy={verticalListSortingStrategy}
        >
          {items.map((item) => (
            <SortableItem
              key={item.id}
              item={item}
              label={label(item)}
              disabled={listDisabled}
              active={activeId === item.id}
              activator={activator}
              suppressClick={suppressClick}
            >
              {children}
            </SortableItem>
          ))}
        </SortableContext>
      </div>
      <DragOverlay
        dropAnimation={
          reducedMotion ? null : { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
        }
      >
        {activeItem ? (
          <div
            className={styles.overlay}
            style={{ width: overlayWidth ?? undefined }}
            aria-hidden="true"
          >
            {children(activeItem, {
              active: true,
              dragging: true,
              overlay: true,
              activatorProps: { ref: () => {} },
            })}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

interface SortableItemProps<T extends { id: string }> {
  item: T
  label: string
  disabled: boolean
  active: boolean
  activator: 'item' | 'child'
  suppressClick: MutableRefObject<boolean>
  children: (item: T, state: SortableRenderState) => ReactNode
}

function SortableItem<T extends { id: string }>({
  item,
  label,
  disabled,
  active,
  activator,
  suppressClick,
  children,
}: SortableItemProps<T>) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: item.id, disabled })
  const filteredListeners = Object.fromEntries(
    Object.entries(listeners ?? {}).map(([name, listener]) => [
      name,
      (event: SyntheticEvent<HTMLElement>) => {
        const target = event.target as Element | null
        if (target?.closest(INTERACTIVE_SELECTOR)) return
        listener(event as never)
      },
    ]),
  ) as HTMLAttributes<HTMLElement>
  const activatorListeners =
    activator === 'item'
      ? filteredListeners
      : (listeners as HTMLAttributes<HTMLElement> | undefined)
  const activatorProps = {
    ref: setActivatorNodeRef as RefCallback<HTMLElement>,
    ...attributes,
    ...activatorListeners,
    'aria-label': `调整 ${label} 顺序`,
    'aria-roledescription': '可排序项',
  } as SortableRenderState['activatorProps']

  return (
    <div
      ref={(node) => {
        setNodeRef(node)
        if (activator === 'item') setActivatorNodeRef(node)
      }}
      className={styles.item}
      data-active={active || undefined}
      data-dragging={isDragging || undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClickCapture={(event) => {
        if (!suppressClick.current) return
        event.preventDefault()
        event.stopPropagation()
      }}
      {...(activator === 'item' ? attributes : {})}
      {...(activator === 'item' ? filteredListeners : {})}
      {...(activator === 'item' ? { 'aria-label': `调整 ${label} 顺序` } : {})}
      {...(activator === 'item' ? { 'aria-roledescription': '可排序项' } : {})}
    >
      {children(item, {
        active,
        dragging: isDragging,
        overlay: false,
        activatorProps,
      })}
    </div>
  )
}
