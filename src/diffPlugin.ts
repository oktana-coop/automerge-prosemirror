import { Plugin, PluginKey } from "prosemirror-state"
import { DecorationSet, EditorView } from "prosemirror-view"
import { next as am } from "@automerge/automerge/slim"
import { patchesToTr } from "./patchesToTr.js"
import { SchemaAdapter } from "./schema.js"

export const diffPluginKey = new PluginKey("automerge-pm-diff")

export const diffPlugin = <T>({
  adapter,
  docBefore,
  docAfter,
  path,
  patches,
}: {
  adapter: SchemaAdapter
  docBefore: am.Doc<T>
  docAfter: am.Doc<T>
  path: am.Prop[]
  patches: am.Patch[]
}) => {
  const plugin = new Plugin({
    key: diffPluginKey,
    view: (editorView: EditorView) => {
      // Create and dispatch the transaction that will create the diff decorations
      // based on the automerge patches
      const tr = patchesToTr({
        adapter,
        path,
        before: docBefore,
        after: docAfter,
        patches,
        state: editorView.state,
        diffMode: true,
      })

      editorView.dispatch(tr)

      return {
        update: () => {},
        destroy: () => {},
      }
    },
    state: {
      init: () => {
        return DecorationSet.empty
      },
      apply: tr => {
        // Handle the transaction's result here by setting the plugin's state to the transaction's decorations meta field.
        // Updating the actual PM view based on the transaction can be handled normally outside the plugin
        return tr.getMeta("decorations") ?? []
      },
    },
    props: {
      decorations(state) {
        // The plugin's state just contains the decorations
        return diffPluginKey.getState(state)
      },
    },
  })
  return plugin
}
