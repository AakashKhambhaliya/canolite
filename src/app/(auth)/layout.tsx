import { Logo } from "@/components/logo";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex">
      {/* Left branding panel */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-800 relative overflow-hidden">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmZmZmYiIGZpbGwtb3BhY2l0eT0iMC4wNSI+PHBhdGggZD0iTTM2IDE0djJoLTJ2LTJoMnptMCAwdjJoLTJ2LTJoMnoiLz48L2c+PC9nPjwvc3ZnPg==')] opacity-40" />
        <div className="relative z-10 flex flex-col justify-center px-16 text-white">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-12 h-12 rounded-xl bg-white/20 backdrop-blur-sm p-1.5 ring-1 ring-white/30">
              <Logo size={36} className="rounded-lg" />
            </div>
            <span className="text-3xl font-bold tracking-tight">Canolite</span>
          </div>
          <h1 className="text-4xl font-bold leading-tight mb-4">
            Design once,
            <br />
            render thousands.
          </h1>
          <p className="text-lg text-blue-100 max-w-md leading-relaxed">
            Self-hosted template-to-image platform. Design templates in a
            visual editor, generate images via API. Perfect for automated
            marketing, social media, and print workflows.
          </p>
          <div className="mt-12 flex gap-8 text-sm text-blue-200">
            <div>
              <div className="text-2xl font-bold text-white">300+</div>
              <div>images/day</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-white">&lt;2s</div>
              <div>render time</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-white">100%</div>
              <div>self-hosted</div>
            </div>
          </div>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex-1 flex items-center justify-center p-8 bg-gray-50 dark:bg-gray-950">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}
