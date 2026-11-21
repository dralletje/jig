import type { ActionKind } from "@jig/core";

/**
 * The transforms of each published codemod package an image can carry, and the kind of each, judged by
 * what it does (`rewrite`: migrates an API or changes behaviour; `sweep`: a behaviour-preserving
 * convention change over many files). The image picks its package with `CODEMOD_PACKAGE`.
 */
export const TRANSFORM_KINDS: Record<string, Record<string, ActionKind>> = {
  "react-codemod": {
    "React-DOM-to-react-dom-factories": "rewrite",
    "React-PropTypes-to-prop-types": "rewrite",
    "ReactNative-View-propTypes": "rewrite",
    class: "rewrite",
    "create-element-to-jsx": "sweep",
    "error-boundaries": "rewrite",
    findDOMNode: "rewrite",
    "manual-bind-to-arrow": "sweep",
    "pure-component": "rewrite",
    "pure-render-mixin": "rewrite",
    "react-to-react-dom": "rewrite",
    "rename-unsafe-lifecycles": "rewrite",
    "sort-comp": "sweep",
    "update-react-imports": "sweep",
  },
};
