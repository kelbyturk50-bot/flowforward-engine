import PrototypeWatermark from '../components/PrototypeWatermark';
import NotFound from '../NotFound';

// The live-chat routes use the same not-found card as the rest of the CRM,
// with the prototype ribbon above it.
export default function LiveChatNotFound() {
  return (
    <div className="prototype-root live-chat-not-found">
      <PrototypeWatermark />
      <NotFound />
    </div>
  );
}
