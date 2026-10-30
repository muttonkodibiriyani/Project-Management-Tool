import sanitizeHtml from 'sanitize-html';

/** gr8r's rich text: comments and task descriptions keep these tags and nothing else (API doc 6.12). */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'span'],
  allowedAttributes: { a: ['href'], span: ['class', 'data-id'] },
  allowedClasses: { span: ['mention'] },
  allowedSchemes: ['https'],
  allowProtocolRelative: false,
  transformTags: {
    // Only https links survive; any other link keeps its text and loses the link.
    a: (tagName, attribs): sanitizeHtml.Tag =>
      attribs.href?.startsWith('https:') ? { tagName, attribs: { href: attribs.href } } : { tagName: 'span', attribs: {} },
  },
};

export const sanitize = (html: string) => sanitizeHtml(html, OPTIONS);
