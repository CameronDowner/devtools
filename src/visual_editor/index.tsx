import mutate, { DeclarativeMutation } from "dom-mutator";
import { debounce } from "lodash";
import React, {
  FC,
  useCallback,
  useEffect,
  useRef,
  useReducer,
  useState,
  useMemo,
} from "react";
import * as ReactDOM from "react-dom/client";

import {
  APIDomMutation,
  APIExperiment,
  APIExperimentVariation,
  APIVisualChange,
  APIVisualChangeset,
} from "../../devtools";
import {
  toggleSelectionMode,
  onSelectionModeUpdate,
} from "./lib/selectionMode";
import getSelector from "./lib/getSelector";
import useFixedPositioning from "./lib/hooks/useFixedPositioning";
import useApi from "./lib/hooks/useApi";
import useQueryParams from "./lib/hooks/useQueryParams";

import Toolbar, { ToolbarMode } from "./Toolbar";
import ElementDetails from "./ElementDetails";
import SelectorDisplay from "./SelectorDisplay";
import FloatingFrame from "./FloatingFrame";
import VisualEditorCss from "./index.css";
import GlobalCSSEditor from "./GlobalCSSEditor";
import VisualEditorPane from "./VisualEditorPane";
import VisualEditorSection from "./VisualEditorSection";
import BreadcrumbsView from "./BreadcrumbsView";
import ClassNamesEdit from "./ClassNamesEdit";
import DOMMutationList from "./DOMMutationList";
import VariationSelector from "./VariationSelector";
import VisualEditorHeader from "./VisualEditorHeader";
import AttributeEdit, { Attribute, IGNORED_ATTRS } from "./AttributeEdit";
import CustomJSEditor from "./CustomJSEditor";
import CSSAttributeEditor from "./CSSAttributeEditor";
import ReloadPageButton from "./ReloadPageButton";
import ErrorDisplay from "./ErrorDisplay";
import BackToGBButton from "./BackToGBButton";
import AIEditorSection from "./AIEditorSection";
import AICopySuggestor from "./AICopySuggestor";
import "./targetPage.css";

declare global {
  interface Window {
    __gb_global_js_err?: (error: string) => void;
  }
}

export interface VisualEditorVariation {
  name: string;
  description: string;
  css?: string;
  js?: string;
  domMutations: APIDomMutation[];
  variationId: string;
}

let _globalStyleTag: HTMLStyleElement | null = null;
let _globalScriptTag: HTMLScriptElement | null = null;

// normalize API payloads into local object shape
const genVisualEditorVariations = ({
  experiment,
  visualChangeset,
}: {
  experiment: APIExperiment;
  visualChangeset: APIVisualChangeset;
}): VisualEditorVariation[] => {
  const { variations } = experiment;
  const { visualChanges } = visualChangeset;
  const visualChangesByVariationId = visualChanges.reduce(
    (acc: Record<string, APIVisualChange>, visualChange: APIVisualChange) => {
      const { variation } = visualChange;
      acc[variation] = visualChange;
      return acc;
    },
    {}
  );

  return variations.map((variation: APIExperimentVariation) => {
    const { name, description, variationId } = variation;
    const {
      css = "",
      js = "",
      domMutations = [],
    } = visualChangesByVariationId[variation.variationId] ?? {};
    return {
      name,
      description,
      variationId,
      css,
      js,
      domMutations,
    };
  });
};

const getHumanReadableText = (element: HTMLElement): string => {
  // ignore when selected is simply wrapper of another element
  if (element.innerHTML.startsWith("<")) return "";
  // hard-limit on text length
  if (element.innerHTML.length > 800) return "";
  const parser = new DOMParser();
  const parsed = parser.parseFromString(element.innerHTML, "text/html");
  const text = parsed.body.textContent || "";
  return text.trim();
};

const VisualEditor: FC<{}> = () => {
  const {
    params,
    visualChangesetId,
    variationIndex,
    hasAiEnabled,
    cleanUpParams,
  } = useQueryParams();
  const [isVisualEditorEnabled, setIsEnabled] = useState(false);
  const [mode, setMode] = useState<ToolbarMode | null>(null);
  const [variations, setVariations] = useState<VisualEditorVariation[]>([]);
  const [selectedElement, setSelectedElement] = useState<HTMLElement | null>(
    null
  );
  const [selectedVariationIndex, setSelectedVariationIndex] =
    useState<number>(variationIndex);
  const [highlightedElementSelector, setHighlightedElementSelector] = useState<
    string | null
  >(null);
  const highlightedElement = useMemo(() => {
    if (!highlightedElementSelector) return null;
    return document.querySelector(highlightedElementSelector);
  }, [highlightedElementSelector]);
  const { x, y, setX, setY, parentStyles } = useFixedPositioning({
    x: 24,
    y: 24,
    rightAligned: true,
  });
  const [, _forceUpdate] = useReducer((x) => x + 1, 0);

  const {
    error,
    cspError,
    loading,
    experiment,
    experimentUrl,
    visualChangeset,
    transformedCopy,
    transformCopy,
    updateVisualChangeset,
  } = useApi({
    visualChangesetId,
    hasAiEnabled,
  });

  const [customJsError, setCustomJsError] = useState("");
  const errorContainerRef = useRef<HTMLDivElement | null>(null);

  const forceUpdate = debounce(_forceUpdate, 100);
  const mutateRevert = useRef<(() => void) | null>(null);

  const selectedVariation = variations?.[selectedVariationIndex] ?? null;

  const updateSelectedVariation = useCallback(
    (updates: Partial<VisualEditorVariation>) => {
      const updatedVariation = {
        ...variations[selectedVariationIndex],
        ...updates,
      };

      const newVariations = [
        ...(variations?.map((v, i) =>
          i === selectedVariationIndex ? updatedVariation : v
        ) ?? []),
      ];

      setVariations(newVariations);

      updateVisualChangeset(newVariations);
    },
    [variations, setVariations, selectedVariationIndex, updateVisualChangeset]
  );

  const addDomMutations = useCallback(
    (domMutations: DeclarativeMutation[]) => {
      updateSelectedVariation({
        domMutations: [...selectedVariation.domMutations, ...domMutations],
      });
    },
    [updateSelectedVariation, selectedVariation]
  );

  const addDomMutation = useCallback(
    (domMutation: DeclarativeMutation) => {
      addDomMutations([domMutation]);
    },
    [addDomMutations]
  );

  // debounced since we accept text input from the user here
  const setGlobalCSS = useCallback(
    debounce((css: string) => {
      updateSelectedVariation({ css });
    }, 500),
    [updateSelectedVariation]
  );

  const setCustomJs = useCallback(
    (js: string) => {
      setCustomJsError("");
      updateSelectedVariation({ js });
    },
    [updateSelectedVariation]
  );

  // the generated selector of the currently selected element
  const selector = useMemo(
    () => (selectedElement ? getSelector(selectedElement) : ""),
    [selectedElement]
  );

  const setHTML = useCallback(
    (html: string) => {
      addDomMutation({
        action: "set",
        attribute: "html",
        value: html,
        selector,
      });
    },
    [selector, addDomMutation]
  );

  const undoHTMLMutations = useMemo(() => {
    const htmlMutations = (selectedVariation?.domMutations ?? []).filter(
      (mutation) =>
        mutation.attribute === "html" && mutation.selector === selector
    );
    if (htmlMutations.length === 0) return;
    return () => {
      removeDomMutations(htmlMutations);
    };
  }, [selectedVariation, selector]);

  // the dom mutations that apply to the currently selected element
  const selectedElementMutations = useMemo(
    () =>
      selectedVariation?.domMutations.filter((m) =>
        selectedElement && selector ? m.selector === selector : true
      ) ?? [],
    [selectedElement, selectedVariation, selector]
  );

  const selectedVariationTotalChangesLength = useMemo(
    () =>
      (selectedVariation?.domMutations ?? []).length +
      (selectedVariation?.js ? 1 : 0) +
      (selectedVariation?.css ? 1 : 0),
    [selectedVariation]
  );

  const addClassNames = useCallback(
    (classNames: string) => {
      if (!selector) return;
      addDomMutations(
        classNames.split(" ").map((className) => ({
          action: "append",
          attribute: "class",
          value: className,
          selector,
        }))
      );
    },
    [selectedElement, addDomMutations]
  );

  const removeClassNames = useCallback(
    (classNames: string) => {
      if (!selector) return;
      addDomMutation({
        action: "remove",
        attribute: "class",
        value: classNames,
        selector,
      });
    },
    [selectedElement, addDomMutation]
  );

  const removeDomMutation = useCallback(
    (mutation: DeclarativeMutation) => {
      updateSelectedVariation({
        domMutations: selectedVariation.domMutations.filter(
          (m) => mutation !== m
        ),
      });
    },
    [updateSelectedVariation, selectedVariation]
  );

  const removeDomMutations = useCallback(
    (mutations: DeclarativeMutation[]) => {
      updateSelectedVariation({
        domMutations: selectedVariation.domMutations.filter(
          (m) => !mutations.includes(m)
        ),
      });
    },
    [updateSelectedVariation, selectedVariation]
  );

  const setAttributes = useCallback(
    (attrs: Attribute[]) => {
      if (!selectedElement) return;
      const existing = [...selectedElement.attributes];
      const removed = existing.filter(
        (e) =>
          !attrs.find((a) => a.name === e.name) &&
          !IGNORED_ATTRS.includes(e.name)
      );
      const changed = attrs.filter(
        (attr) => attr.value !== selectedElement.getAttribute(attr.name)
      );
      removed.forEach((attr) => {
        addDomMutation({
          action: "remove",
          attribute: attr.name,
          selector,
          value: attr.value,
        });
      });
      changed.forEach((attr) => {
        addDomMutation({
          action: selectedElement.hasAttribute(attr.name) ? "set" : "append",
          attribute: attr.name,
          selector,
          value: attr.value,
        });
      });
    },
    [selectedElement, addDomMutation]
  );

  const setCSS = useCallback(
    (css: string) => {
      if (!selector) return;
      addDomMutation({
        action: "set",
        attribute: "style",
        value: css,
        selector,
      });
    },
    [selector, addDomMutation]
  );

  const humanReadableText = useMemo(() => {
    if (!selectedElement) return "";
    return getHumanReadableText(selectedElement);
  }, [getHumanReadableText, selectedElement, selectedElement?.innerHTML]);

  const selectedElementHasCopy = useMemo(() => {
    return humanReadableText.length > 0;
  }, [humanReadableText]);

  // on visual changeset change
  useEffect(() => {
    if (!visualChangeset || !experiment) return;
    if (mode === null) setMode("selection");

    const visualEditorVariations = genVisualEditorVariations({
      experiment,
      visualChangeset,
    });

    setVariations(visualEditorVariations);
  }, [visualChangeset, experiment]);

  // init visual editor
  useEffect(() => {
    if (isVisualEditorEnabled) return;
    cleanUpParams();
    setIsEnabled(true);
  }, [visualChangeset, experiment, isVisualEditorEnabled, error]);

  // handle mode selection
  useEffect(() => {
    toggleSelectionMode({
      isEnabled: !isVisualEditorEnabled
        ? isVisualEditorEnabled
        : mode === "selection",
      selectedElement,
      setSelectedElement,
      setHighlightedElementSelector,
      addDomMutation,
    });
  }, [isVisualEditorEnabled, mode]);

  // selection mode - update on select
  useEffect(() => {
    if (!isVisualEditorEnabled) return;
    if (mode !== "selection") return;

    onSelectionModeUpdate({
      selectedElement,
      setSelectedElement,
      setHighlightedElementSelector,
      addDomMutation,
    });
  }, [
    selectedElement,
    setSelectedElement,
    setHighlightedElementSelector,
    isVisualEditorEnabled,
    mode,
  ]);

  // upon every DOM mutation, we revert all changes and replay them to ensure
  // that the DOM is in the correct state
  useEffect(() => {
    // run reverts if they exist
    if (mutateRevert?.current) mutateRevert.current();

    const revertCallbacks: Array<() => void> = [];

    selectedVariation?.domMutations.forEach((mutation) => {
      const controller = mutate.declarative(mutation);
      revertCallbacks.push(controller.revert);
    });

    mutateRevert.current = () => {
      revertCallbacks.reverse().forEach((c) => c());
    };
  }, [variations, selectedVariation]);

  // Upon any DOM change on the page, we trigger a refresh of visual editor to
  // keep it in sync
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTimeout(() => forceUpdate(), 0)
    );
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);

  // generate a style tag to hold the global CSS
  useEffect(() => {
    if (_globalStyleTag) _globalStyleTag.remove();
    if (!selectedVariation?.css) return;
    _globalStyleTag = document.createElement("style");
    document.head.appendChild(_globalStyleTag);
    _globalStyleTag.innerHTML = selectedVariation?.css ?? "";
  }, [selectedVariation]);

  // generate a script tag to hold custom JS
  // renders only when js changes
  useEffect(() => {
    setCustomJsError("");
    if (_globalScriptTag) _globalScriptTag?.remove();
    if (!selectedVariation?.js) return;
    _globalScriptTag = document.createElement("script");
    document.body.appendChild(_globalScriptTag);
    window.__gb_global_js_err = setCustomJsError;
    _globalScriptTag.innerHTML =
      `try { ${selectedVariation?.js} } catch(e) { window.__gb_global_js_err(e.message); }` ??
      "";
  }, [selectedVariation?.js]);

  // scroll to error
  useEffect(() => {
    if (!error && !cspError && !errorContainerRef.current) return;
    errorContainerRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [error, cspError, errorContainerRef.current]);

  if (!isVisualEditorEnabled) return null;

  return (
    <>
      <VisualEditorPane style={parentStyles}>
        <VisualEditorHeader reverseX x={x} y={y} setX={setX} setY={setY} />

        <VariationSelector
          variations={variations}
          selectedVariationIndex={selectedVariationIndex}
          setSelectedVariationIndex={setSelectedVariationIndex}
        />

        <Toolbar
          disabled={!visualChangeset}
          mode={mode}
          setMode={setMode}
          clearSelectedElement={() => setSelectedElement(null)}
        />

        {mode === "selection" && selectedElement ? (
          <>
            <VisualEditorSection title="Breadcrumbs">
              <BreadcrumbsView
                element={selectedElement}
                setElement={setSelectedElement}
              />
            </VisualEditorSection>

            <VisualEditorSection title="Element Details">
              <ElementDetails
                selector={selector}
                element={selectedElement}
                setHTML={setHTML}
                undoHTMLMutations={undoHTMLMutations}
              />
            </VisualEditorSection>

            <AIEditorSection isVisible={hasAiEnabled && selectedElementHasCopy}>
              <AICopySuggestor
                loading={loading}
                parentElement={selectedElement}
                setHTML={setHTML}
                copy={humanReadableText}
                transformCopy={transformCopy}
                transformedCopy={transformedCopy}
              />
            </AIEditorSection>

            <VisualEditorSection title="Attributes">
              <AttributeEdit element={selectedElement} onSave={setAttributes} />
            </VisualEditorSection>

            {/** SVGs do not work with class name editor ATM; See issue GB-194 **/}
            {!["svg", "path"].includes(selectedElement.tagName) && (
              <VisualEditorSection title="Class names">
                <ClassNamesEdit
                  element={selectedElement}
                  onRemove={removeClassNames}
                  onAdd={addClassNames}
                />
              </VisualEditorSection>
            )}

            <VisualEditorSection isCollapsible title={`CSS attributes`}>
              <CSSAttributeEditor
                selectedElement={selectedElement}
                setCSS={setCSS}
              />
            </VisualEditorSection>

            <VisualEditorSection
              isCollapsible
              title={`Changes (${selectedElementMutations.length})`}
            >
              <DOMMutationList
                mutations={selectedElementMutations ?? []}
                removeDomMutation={removeDomMutation}
              />
            </VisualEditorSection>
          </>
        ) : null}

        {mode === "js" && (
          <VisualEditorSection title="Custom JS">
            <CustomJSEditor
              js={selectedVariation.js}
              onSubmit={setCustomJs}
              onError={setCustomJsError}
            />
            {customJsError && (
              <div className="gb-px-4 gb-py-2 gb-text-rose-500">
                JS error: {customJsError}
              </div>
            )}
          </VisualEditorSection>
        )}

        {mode === "css" && (
          <VisualEditorSection title="Global CSS">
            <GlobalCSSEditor
              css={selectedVariation.css}
              onSubmit={setGlobalCSS}
            />
          </VisualEditorSection>
        )}

        {mode === "changes" && (
          <VisualEditorSection
            isCollapsible
            isExpanded
            title={`Changes (${selectedVariationTotalChangesLength})`}
          >
            <DOMMutationList
              addMutation={addDomMutation}
              globalCss={selectedVariation.css}
              clearGlobalCss={() => setGlobalCSS("")}
              customJs={selectedVariation.js}
              clearCustomJs={() => setCustomJs("")}
              removeDomMutation={removeDomMutation}
              mutations={selectedVariation?.domMutations ?? []}
            />
          </VisualEditorSection>
        )}

        {error ? (
          <div ref={errorContainerRef}>
            <ErrorDisplay error={error} cspError={cspError} />
          </div>
        ) : null}

        <div className="gb-m-4 gb-text-center">
          <BackToGBButton experimentUrl={experimentUrl}>
            Done Editing
          </BackToGBButton>
          <ReloadPageButton
            params={params}
            variationIndex={variationIndex}
            visualChangesetId={visualChangesetId}
            hasAiEnabled={hasAiEnabled}
          />
        </div>
      </VisualEditorPane>

      {/** Overlays for highlighting selected/hovered elements **/}
      {mode === "selection" && selectedElement ? (
        <>
          <FloatingFrame parentElement={selectedElement} />
          <SelectorDisplay selector={selector} />
        </>
      ) : null}
      {mode === "selection" ? (
        <>
          <FloatingFrame parentElement={highlightedElement} />
          <SelectorDisplay selector={highlightedElementSelector} />
        </>
      ) : null}
    </>
  );
};

/**
 * mounting the visual editor
 */
export const CONTAINER_ID = "__gb_visual_editor";

const container = document.createElement("div");
container.id = CONTAINER_ID;

export const shadowRoot = container?.attachShadow({ mode: "open" });

if (shadowRoot) {
  shadowRoot.innerHTML = `
    <style>${VisualEditorCss}</style>
    <div id="visual-editor-root"></div>
  `;
}

document.body.appendChild(container);

const root = ReactDOM.createRoot(
  shadowRoot.querySelector("#visual-editor-root")!
);

root.render(
  <React.StrictMode>
    <VisualEditor />
  </React.StrictMode>
);
