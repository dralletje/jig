import type { ActionKind } from "@jig/core";

/** One transform of a codemod package: the kind of its commits, and one line on what it does. */
export type TransformInfo = { kind: ActionKind; description: string };

/**
 * The transforms of each published codemod package an image can carry: the kind of each, judged by what
 * it does (`rewrite`: migrates an API or changes behaviour; `sweep`: a behaviour-preserving convention
 * change over many files), and one line on what it does, from the package's README. The image picks its
 * package with `CODEMOD_PACKAGE`.
 */
export const TRANSFORMS: Record<string, Record<string, TransformInfo>> = {
  "react-codemod": {
    "React-DOM-to-react-dom-factories": {
      kind: "rewrite",
      description: "Converts React.DOM.div(...) calls to React.createElement('div', ...).",
    },
    "React-PropTypes-to-prop-types": {
      kind: "rewrite",
      description: "Replaces React.PropTypes with the prop-types package and adds its import or require.",
    },
    "ReactNative-View-propTypes": {
      kind: "rewrite",
      description: "Replaces View.propTypes with ViewPropTypes and adds its import or require (React Native 0.44+).",
    },
    class: {
      kind: "rewrite",
      description: "Converts React.createClass components to ES2015 classes, else to create-react-class.",
    },
    "create-element-to-jsx": {
      kind: "sweep",
      description: "Converts React.createElement calls to JSX.",
    },
    "error-boundaries": {
      kind: "rewrite",
      description: "Renames the unstable_handleError lifecycle method to componentDidCatch.",
    },
    findDOMNode: {
      kind: "rewrite",
      description: "Changes getDOMNode() calls in React.createClass components to React.findDOMNode().",
    },
    "manual-bind-to-arrow": {
      kind: "sweep",
      description: "Converts this.f = this.f.bind(this) in class constructors to arrow function properties.",
    },
    "pure-component": {
      kind: "rewrite",
      description: "Converts classes that only render, without state or refs, to function components.",
    },
    "pure-render-mixin": {
      kind: "rewrite",
      description: "Removes PureRenderMixin and inlines its shouldComponentUpdate.",
    },
    "react-to-react-dom": {
      kind: "rewrite",
      description: "Moves DOM calls such as React.render to react-dom (CommonJS require only).",
    },
    "rename-unsafe-lifecycles": {
      kind: "rewrite",
      description: "Adds the UNSAFE_ prefix to the deprecated lifecycle methods.",
    },
    "sort-comp": {
      kind: "sweep",
      description: "Reorders component methods to match ESLint's react/sort-comp rule (Airbnb's order).",
    },
    "update-react-imports": {
      kind: "sweep",
      description: "Removes React imports the new JSX transform does not need; default imports become named.",
    },
  },
};
