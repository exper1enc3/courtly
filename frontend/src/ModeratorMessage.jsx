import { useEffect, useRef } from "react";

export default function ModeratorMessage({ message }) {
  const containerRef = useRef(null);
  const renderedMessage = useRef(null);

  useEffect(() => {
    if (renderedMessage.current === message) return;
    renderedMessage.current = message;

    // Intentionally vulnerable for the XSS demo in moderator requests only.
    const container = containerRef.current;
    container.innerHTML = message;

    // Scripts inserted with innerHTML are inert; recreate them to execute them.
    for (const original of container.querySelectorAll("script")) {
      const script = document.createElement("script");
      for (const attribute of original.attributes) {
        script.setAttribute(attribute.name, attribute.value);
      }
      script.textContent = original.textContent;
      original.replaceWith(script);
    }
  }, [message]);

  return <p ref={containerRef} />;
}
