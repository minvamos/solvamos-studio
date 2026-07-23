import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Props = {
  text: string;
  sender: 'user' | 'agent' | 'system';
};

/** Safe markdown for agent replies; raw HTML is intentionally not enabled. */
export default function ChatMessageBody({ text, sender }: Props) {
  if (sender === 'user') {
    return <span className="whitespace-pre-wrap break-words">{text}</span>;
  }

  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          code: ({ children, ...props }) => <code {...props}>{children}</code>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

