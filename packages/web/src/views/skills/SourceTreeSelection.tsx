import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from 'react-arborist'
import {
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  ExternalLink,
  Eye,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  Link2,
  List,
  LoaderCircle,
  PackageCheck,
  Search,
  Send,
  TreePine,
  X,
} from 'lucide-react'
import {
  mapProjectionRoots,
  normalizeSourceResources,
  resourceSelectionState,
  type SourceResourceKind,
  type SourceResourceRule,
  type SourceResources,
  type SourceTreeBundleNode,
  type SourceTreeDiagnostic,
  type SourceTreeNode,
} from '@loom/core'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { inferRepositoryFileWebUrl } from '@/lib/repository-links'
import { skillFolderDisplayPath } from './source-paths'
import styles from './SourceTreeSelection.module.css'

type ViewMode = 'bundles' | 'tree'

export interface SourceTreeSelectionValue {
  memberEntries: Set<string>
  resources: SourceResources
}

interface Props {
  nodes: SourceTreeNode[]
  sourceName: string
  value: SourceTreeSelectionValue
  onChange: (next: SourceTreeSelectionValue) => void
  diagnostics?: readonly SourceTreeDiagnostic[]
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  sourceUrl?: string
  sourceRef?: string
  onOpenBundle?: (bundle: SourceTreeBundleNode) => void
  className?: string
}

interface SelectableItem {
  id: string
  selected: boolean
  kind: 'bundle' | 'resource'
}

function flatten(nodes: readonly SourceTreeNode[]): SourceTreeNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.kind === 'container' ? flatten(node.children) : []),
  ])
}

function bundlesBelow(node: SourceTreeNode, unavailable: ReadonlySet<string>): SourceTreeNode[] {
  if (node.kind === 'bundle') return unavailable.has(node.entry) ? [] : [node]
  return node.kind === 'container'
    ? node.children.flatMap((child) => bundlesBelow(child, unavailable))
    : []
}

function resourceLeavesBelow(
  node: SourceTreeNode,
  unavailable: ReadonlySet<string>,
): SourceTreeNode[] {
  if (node.kind === 'resource') return unavailable.has(node.path) ? [] : [node]
  return node.kind === 'container'
    ? node.children.flatMap((child) => resourceLeavesBelow(child, unavailable))
    : []
}

function containsUnavailableEntry(node: SourceTreeNode): boolean {
  if (node.kind === 'symlink' || node.kind === 'submodule') return true
  return node.kind === 'container' && node.children.some(containsUnavailableEntry)
}

function resourceRootsBelow(
  node: SourceTreeNode,
  unavailable: ReadonlySet<string>,
): SourceTreeNode[] {
  if (node.kind === 'resource') return unavailable.has(node.path) ? [] : [node]
  if (node.kind !== 'container') return []
  const resources = resourceLeavesBelow(node, unavailable)
  if (resources.length > 0 && !containsUnavailableEntry(node)) {
    return [node]
  }
  return node.children.flatMap((child) => resourceRootsBelow(child, unavailable))
}

function resourceKind(node: SourceTreeNode): SourceResourceKind {
  return node.kind === 'container' ? 'directory' : 'file'
}

function selectionLabel(node: SourceTreeNode): string {
  if (node.path) return node.path
  return node.kind === 'bundle' ? node.entry : 'repository root'
}

function projectionRootsForPaths(paths: readonly string[]) {
  if (paths.includes('')) return [{ sourcePath: '', targetPath: '' }]
  return mapProjectionRoots(paths)
}

function resourceSelected(node: SourceTreeNode, resources: SourceResources): boolean {
  return resourceSelectionState(node.path, resourceKind(node), resources).selected
}

function selectableItems(
  node: SourceTreeNode,
  value: SourceTreeSelectionValue,
  unavailable: ReadonlySet<string>,
): SelectableItem[] {
  return [
    ...bundlesBelow(node, unavailable).map((bundle) => ({
      id: bundle.kind === 'bundle' ? bundle.entry : bundle.path,
      selected: bundle.kind === 'bundle' && value.memberEntries.has(bundle.entry),
      kind: 'bundle' as const,
    })),
    ...resourceLeavesBelow(node, unavailable).map((resource) => ({
      id: resource.path,
      selected: resourceSelected(resource, value.resources),
      kind: 'resource' as const,
    })),
  ]
}

function isSameOrDescendant(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

function withoutSubtree(rules: readonly SourceResourceRule[], path: string): SourceResourceRule[] {
  return rules.filter((rule) => !isSameOrDescendant(rule.path, path))
}

function setResourceRoot(
  resources: SourceResources,
  node: SourceTreeNode,
  selected: boolean,
): SourceResources {
  const path = node.path
  const kind = resourceKind(node)
  const next = {
    include: withoutSubtree(resources.include, path),
    exclude: withoutSubtree(resources.exclude, path),
  }
  const inherited = resourceSelectionState(path, kind, next).selected
  if (inherited !== selected) {
    ;(selected ? next.include : next.exclude).push({ path, kind })
  }
  return normalizeSourceResources(next)
}

function setResourceRoots(
  resources: SourceResources,
  roots: readonly SourceTreeNode[],
  selected: boolean,
): SourceResources {
  return roots.reduce((next, root) => setResourceRoot(next, root, selected), resources)
}

function TriCheckbox({
  checked,
  mixed,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  mixed: boolean
  disabled?: boolean
  label: string
  onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed
  }, [mixed])

  return (
    <label className={styles.treeCheck} onClick={(event) => event.stopPropagation()}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={onChange}
      />
      <span aria-hidden="true">{checked && <Check size={12} strokeWidth={3} />}</span>
    </label>
  )
}

function useElementHeight(minimum: number) {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [height, setHeight] = useState(minimum)

  useLayoutEffect(() => {
    if (!element) return
    const measure = () =>
      setHeight(Math.max(minimum, Math.floor(element.getBoundingClientRect().height)))
    measure()
    const frame = window.requestAnimationFrame(measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [element, minimum])

  return { height, ref: setElement }
}

function nodeIcon(node: NodeApi<SourceTreeNode>) {
  const item = node.data
  if (item.kind === 'bundle') return <PackageCheck size={15} />
  if (item.kind === 'resource') {
    return item.name.endsWith('.ts') || item.name.endsWith('.tsx') ? (
      <FileCode2 size={15} />
    ) : (
      <FileText size={15} />
    )
  }
  if (item.kind === 'symlink') return <Link2 size={15} />
  if (item.kind === 'submodule') return <GitCommitHorizontal size={15} />
  return node.isOpen ? <FolderOpen size={15} /> : <Folder size={15} />
}

export default function SourceTreeSelection({
  nodes,
  sourceName,
  value,
  onChange,
  diagnostics = [],
  loading = false,
  error = null,
  onRetry,
  sourceUrl,
  sourceRef,
  onOpenBundle,
  className = '',
}: Props) {
  const [view, setView] = useState<ViewMode>('bundles')
  const [search, setSearch] = useState('')
  const treeRef = useRef<TreeApi<SourceTreeNode>>(null)
  const { height: treeHeight, ref: setTreeViewport } = useElementHeight(190)
  const allNodes = useMemo(() => flatten(nodes), [nodes])
  const unavailable = useMemo(() => {
    const identities = new Set<string>()
    for (const diagnostic of diagnostics) {
      identities.add(diagnostic.path)
      if (diagnostic.code !== 'invalid-nested-bundle') {
        for (const relatedPath of diagnostic.relatedPaths ?? []) identities.add(relatedPath)
      }
    }
    return identities
  }, [diagnostics])
  const bundles = allNodes.filter((node) => node.kind === 'bundle')
  const resourceLeaves = allNodes.filter((node) => node.kind === 'resource')
  const selectedBundles = bundles.filter(
    (node) =>
      node.kind === 'bundle' && !unavailable.has(node.entry) && value.memberEntries.has(node.entry),
  )
  const selectedResources = resourceLeaves.filter(
    (node) => !unavailable.has(node.path) && resourceSelected(node, value.resources),
  )
  const projectionRoots = useMemo(() => {
    const selectedPaths = [
      ...selectedBundles.map((node) => node.path),
      ...nodes
        .flatMap((node) => resourceRootsBelow(node, unavailable))
        .flatMap((root) => {
          const leaves = resourceLeavesBelow(root, unavailable)
          if (
            leaves.length > 0 &&
            leaves.every((leaf) => resourceSelected(leaf, value.resources))
          ) {
            return [root.path]
          }
          return leaves
            .filter((leaf) => resourceSelected(leaf, value.resources))
            .map((leaf) => leaf.path)
        }),
    ]
    return projectionRootsForPaths(selectedPaths)
  }, [nodes, selectedBundles, unavailable, value.resources])
  const visibleBundles = bundles.filter((node) => {
    const term = search.trim().toLowerCase()
    return (
      !term ||
      `${node.name} ${node.path} ${node.kind === 'bundle' ? (node.description ?? '') : ''}`
        .toLowerCase()
        .includes(term)
    )
  })
  const searchTerm = search.trim().toLowerCase()
  const availableResourceKinds = useMemo(() => {
    const kinds = new Map<string, SourceResourceKind>()
    for (const node of allNodes) {
      if (node.kind === 'resource' && !unavailable.has(node.path)) {
        kinds.set(node.path, 'file')
      } else if (
        node.kind === 'container' &&
        resourceRootsBelow(node, unavailable).some((root) => root.path === node.path)
      ) {
        kinds.set(node.path, 'directory')
      }
    }
    return kinds
  }, [allNodes, unavailable])
  const unavailableResourceRules = (['include', 'exclude'] as const).flatMap((action) =>
    value.resources[action]
      .filter((rule) => availableResourceKinds.get(rule.path) !== rule.kind)
      .map((rule) => ({ action, rule })),
  )
  const allResourcesSelected =
    resourceLeaves.some((resource) => !unavailable.has(resource.path)) &&
    resourceLeaves
      .filter((resource) => !unavailable.has(resource.path))
      .every((resource) => resourceSelected(resource, value.resources))

  const toggleNode = (node: SourceTreeNode) => {
    const items = selectableItems(node, value, unavailable)
    if (items.length === 0) return
    const nextSelected = !items.every((item) => item.selected)
    const memberEntries = new Set(value.memberEntries)
    for (const bundle of bundlesBelow(node, unavailable)) {
      if (bundle.kind !== 'bundle') continue
      if (nextSelected) memberEntries.add(bundle.entry)
      else memberEntries.delete(bundle.entry)
    }
    const resources = setResourceRoots(
      value.resources,
      resourceRootsBelow(node, unavailable),
      nextSelected,
    )
    onChange({ memberEntries, resources })
  }

  const toggleResources = () => {
    onChange({
      memberEntries: new Set(value.memberEntries),
      resources: setResourceRoots(
        value.resources,
        nodes.flatMap((node) => resourceRootsBelow(node, unavailable)),
        !allResourcesSelected,
      ),
    })
  }

  const removeUnavailableResourceRule = (
    action: 'include' | 'exclude',
    rule: SourceResourceRule,
  ) => {
    onChange({
      memberEntries: new Set(value.memberEntries),
      resources: normalizeSourceResources({
        ...value.resources,
        [action]: value.resources[action].filter(
          (candidate) => candidate.path !== rule.path || candidate.kind !== rule.kind,
        ),
      }),
    })
  }

  function TreeNode({ node, style }: NodeRendererProps<SourceTreeNode>) {
    const item = node.data
    const items = selectableItems(item, value, unavailable)
    const checked = items.length > 0 && items.every((entry) => entry.selected)
    const mixed = !checked && items.some((entry) => entry.selected)
    const disabled = item.kind === 'symlink' || item.kind === 'submodule' || items.length === 0
    return (
      <div
        className={`${styles.treeRow} ${item.kind === 'bundle' ? styles.bundleTreeRow : ''}`}
        style={style as CSSProperties}
        data-selected={checked || undefined}
        data-disabled={disabled || undefined}
        data-expandable={node.isInternal || undefined}
        onClick={() => {
          if (node.isInternal) node.toggle()
        }}
      >
        <button
          type="button"
          className={styles.treeToggle}
          aria-label={`${node.isOpen ? 'Collapse' : 'Expand'} ${item.name}`}
          aria-hidden={!node.isInternal}
          tabIndex={node.isInternal ? 0 : -1}
          onClick={(event) => {
            event.stopPropagation()
            node.toggle()
          }}
        >
          {node.isInternal ? (
            node.isOpen ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : null}
        </button>
        <TriCheckbox
          checked={checked}
          mixed={mixed}
          disabled={disabled}
          label={`Select ${selectionLabel(item)}`}
          onChange={() => toggleNode(item)}
        />
        <span className={styles.treeKindIcon} aria-hidden="true">
          {nodeIcon(node)}
        </span>
        <span className={styles.treeName}>{item.name}</span>
        {item.kind === 'bundle' && <span className={styles.bundleMark}>SKILL</span>}
        {(item.kind === 'symlink' || item.kind === 'submodule') && (
          <span className={styles.disabledMark}>unavailable</span>
        )}
      </div>
    )
  }

  if (loading) {
    return (
      <div className={`${styles.statePanel} ${className}`} aria-live="polite">
        <LoaderCircle className={styles.spin} size={20} />
        <strong>Reading repository tree</strong>
        <span>Resolving the selected commit...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`${styles.statePanel} ${styles.errorState} ${className}`} role="alert">
        <CircleAlert size={20} />
        <strong>Repository tree could not be loaded</strong>
        <span>{error}</span>
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className={`${styles.selectionPane} ${className}`}>
      <div className={styles.selectionToolbar} data-view={view}>
        <div className={styles.viewSwitch} role="tablist" aria-label="Source contents view">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'bundles'}
            onClick={() => setView('bundles')}
          >
            <List size={14} />
            Bundles
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'tree'}
            onClick={() => setView('tree')}
          >
            <TreePine size={14} />
            Tree
          </button>
        </div>
        <div className={styles.searchControl}>
          <Search size={14} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search source contents"
            placeholder={view === 'tree' ? 'Search paths...' : 'Search bundles...'}
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
              Clear
            </button>
          )}
        </div>
        {view === 'tree' && (
          <div className={styles.treeActions}>
            <IconButton
              label="Expand all"
              size="xs"
              disabled={searchTerm.length > 0}
              onClick={() => treeRef.current?.openAll()}
            >
              <ChevronsUpDown size={14} />
            </IconButton>
            <IconButton
              label="Collapse all"
              size="xs"
              disabled={searchTerm.length > 0}
              onClick={() => treeRef.current?.closeAll()}
            >
              <ChevronsDownUp size={14} />
            </IconButton>
            <Button variant="ghost" size="xs" onClick={toggleResources}>
              <Boxes size={13} />
              {allResourcesSelected ? 'Clear resources' : 'Select resources'}
            </Button>
          </div>
        )}
      </div>

      <div className={styles.selectionSummary}>
        <span>{selectedBundles.length} bundles</span>
        <span>{selectedResources.length} resources</span>
        <code>{projectionRoots.length} projection roots</code>
      </div>

      {view === 'bundles' ? (
        <div
          className={styles.bundleList}
          role="list"
          aria-label="Skill bundles"
          data-empty={bundles.length === 0 || visibleBundles.length === 0 || undefined}
        >
          {bundles.length === 0 && !searchTerm ? (
            <div className={styles.emptyResult}>
              <PackageCheck size={18} />
              <strong>No skill bundles at this commit</strong>
              <span>Choose another ref to continue.</span>
            </div>
          ) : visibleBundles.length === 0 ? (
            <div className={styles.emptyResult}>
              <Search size={18} />
              <strong>No bundles match</strong>
              <span>Try a skill name or repository path.</span>
            </div>
          ) : (
            visibleBundles.map((bundle) => {
              if (bundle.kind !== 'bundle') return null
              const active = value.memberEntries.has(bundle.entry)
              const disabled = unavailable.has(bundle.entry)
              const bundleFileUrl =
                sourceUrl && sourceRef
                  ? inferRepositoryFileWebUrl(sourceUrl, sourceRef, bundle.entry)
                  : null
              const displayPath = skillFolderDisplayPath(bundle.entry)
              const canOpenBundle = !disabled && Boolean(onOpenBundle)
              const openBundle = () => {
                if (!disabled) onOpenBundle?.(bundle)
              }
              return (
                <div
                  key={bundle.entry}
                  className={styles.bundleRow}
                  data-selected={active || undefined}
                  data-disabled={disabled || undefined}
                  data-viewable={canOpenBundle || undefined}
                  role="listitem"
                  tabIndex={canOpenBundle ? 0 : undefined}
                  onClick={openBundle}
                  onKeyDown={(event) => {
                    if (!canOpenBundle || event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      openBundle()
                    }
                  }}
                >
                  <TriCheckbox
                    checked={active}
                    mixed={false}
                    disabled={disabled}
                    label={`Select ${selectionLabel(bundle)}`}
                    onChange={() => toggleNode(bundle)}
                  />
                  <span className={styles.bundleIcon} aria-hidden="true">
                    <PackageCheck size={12} />
                  </span>
                  <span className={styles.bundleCopy}>
                    <span className={styles.bundleHeading}>
                      {bundleFileUrl ? (
                        <a
                          className={styles.bundleNameLink}
                          href={bundleFileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={bundleFileUrl}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <strong>{bundle.name}</strong>
                          <ExternalLink size={11} />
                        </a>
                      ) : (
                        <strong>{bundle.name}</strong>
                      )}
                      <code title={bundle.entry}>{displayPath}</code>
                      {disabled && <small className={styles.disabledMark}>unavailable</small>}
                    </span>
                    {bundle.description && <span>{bundle.description}</span>}
                  </span>
                  {canOpenBundle && (
                    <span
                      className={styles.bundleViewAction}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <IconButton
                        label={`View ${bundle.name}`}
                        tooltip="View skill"
                        size="xs"
                        onClick={openBundle}
                      >
                        <Eye size={13} />
                      </IconButton>
                    </span>
                  )}
                </div>
              )
            })
          )}
        </div>
      ) : nodes.length === 0 ? (
        <div className={`${styles.emptyResult} ${styles.treeEmpty}`}>
          <TreePine size={20} />
          <strong>No tracked content at this commit</strong>
          <span>Choose another ref to continue.</span>
        </div>
      ) : (
        <div className={styles.treeViewport} ref={setTreeViewport}>
          <Tree<SourceTreeNode>
            ref={treeRef}
            data={nodes}
            idAccessor={(node) =>
              node.kind === 'bundle' ? `bundle:${node.entry}` : `${node.kind}:${node.path}`
            }
            childrenAccessor={(node) => (node.kind === 'container' ? node.children : null)}
            width="100%"
            height={treeHeight}
            indent={20}
            rowHeight={34}
            overscanCount={4}
            openByDefault
            disableDrag
            disableEdit
            disableDrop
            selectionFollowsFocus={false}
            searchTerm={search}
            searchMatch={(node: NodeApi<SourceTreeNode>, term: string) =>
              `${node.data.name} ${node.data.path}`.toLowerCase().includes(term.toLowerCase())
            }
          >
            {TreeNode}
          </Tree>
        </div>
      )}

      {unavailableResourceRules.length > 0 && (
        <div
          className={styles.unavailableSelections}
          role="region"
          aria-label="Unavailable resource selections"
        >
          <div className={styles.unavailableHeading}>
            <span>
              <CircleAlert size={13} />
              Unavailable selections
            </span>
            <code>{unavailableResourceRules.length}</code>
          </div>
          <div className={styles.unavailableList}>
            {unavailableResourceRules.map(({ action, rule }) => (
              <div key={`${action}:${rule.path}:${rule.kind}`} className={styles.unavailableRow}>
                <code>{rule.path}</code>
                <span>
                  {action} · {rule.kind}
                </span>
                <button
                  type="button"
                  title="Remove unavailable selection"
                  aria-label={`Remove unavailable ${action} ${rule.path}`}
                  onClick={() => removeUnavailableResourceRule(action, rule)}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={styles.projectionPreview}>
        <div className={styles.previewHeading}>
          <span>
            <Send size={13} />
            Projection preview
          </span>
          <code>source: {sourceName}</code>
        </div>
        <div className={styles.previewPaths}>
          {projectionRoots.length === 0 ? (
            <span className={styles.noProjection}>Select at least one bundle or resource.</span>
          ) : (
            projectionRoots.slice(0, 6).map((root) => (
              <code key={`${root.sourcePath}:${root.targetPath}`}>
                <span>&lt;agent-skills&gt;/</span>
                {sourceName}
                {root.targetPath && (
                  <>
                    /<strong>{root.targetPath}</strong>
                  </>
                )}
              </code>
            ))
          )}
          {projectionRoots.length > 6 && <code>+{projectionRoots.length - 6} more paths</code>}
        </div>
      </div>
    </div>
  )
}
