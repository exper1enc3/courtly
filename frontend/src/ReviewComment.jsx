import { useEffect, useRef } from "react";

export default function ReviewComment({ comment }) {
  const containerRef = useRef(null);
  const renderedComment = useRef(null);

  useEffect(() => {
    if (renderedComment.current === comment) return;
    renderedComment.current = comment;

    // Intentionally vulnerable for the XSS demo: render stored, untrusted HTML.
    const container = containerRef.current;
    container.innerHTML = comment;

    // Scripts inserted with innerHTML are inert; recreate them to execute them.
    for (const original of container.querySelectorAll("script")) {
      const script = document.createElement("script");
      for (const attribute of original.attributes) {
        script.setAttribute(attribute.name, attribute.value);
      }
      script.textContent = original.textContent;
      original.replaceWith(script);
    }
  }, [comment]);

  return <p ref={containerRef} />;
}
