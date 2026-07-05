import { Check, Layers3, Plus, X } from 'lucide-react'

interface Props {
  environments: string[]
  selected: string | null
  previewChain: string[]
  pending: boolean
  onSelect: (name: string) => void
  onRemoveFromChain: (name: string) => void
  onCreate: () => void
}

export default function EnvironmentSidebar(props: Props) {
  return (
    <aside className="vars-environments" aria-label="变量环境" aria-busy={props.pending}>
      <div className="vars-pane-heading">
        <div>
          <span className="vars-eyebrow">环境</span>
          <h2>配置层</h2>
        </div>
        <button
          className="vars-icon-button"
          type="button"
          onClick={props.onCreate}
          disabled={props.pending}
          aria-label="新建环境"
        >
          <Plus size={17} />
        </button>
      </div>
      <div className="vars-environment-list">
        {props.environments.map((name) => (
          <button
            className="vars-environment-button"
            type="button"
            key={name}
            aria-current={props.selected === name ? 'true' : undefined}
            aria-pressed={props.selected === name}
            onClick={() => props.onSelect(name)}
          >
            <Layers3 size={16} />
            <span>{name}</span>
            {props.previewChain.includes(name) && (
              <Check className="vars-check" size={15} aria-label="已加入预览" />
            )}
          </button>
        ))}
      </div>
      <section className="vars-chain" aria-labelledby="vars-chain-title">
        <div className="vars-chain-label">
          <span id="vars-chain-title">预览链</span>
          <span>{props.previewChain.length} 层</span>
        </div>
        <div className="vars-chain-rail" aria-label="预览环境链">
          {props.previewChain.map((name, index) => (
            <div className="vars-chain-step" key={name}>
              <span className="vars-chain-index">{index + 1}</span>
              <button
                type="button"
                onClick={() => props.onRemoveFromChain(name)}
                aria-label={`从预览链移除 ${name}`}
              >
                <span>{name}</span>
                <X size={14} />
              </button>
            </div>
          ))}
          {props.previewChain.length === 0 && <p>点击环境以建立预览链</p>}
        </div>
      </section>
    </aside>
  )
}
