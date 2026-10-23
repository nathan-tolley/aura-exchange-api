import type { SVGProps } from "react";

const Icon = ({ children, ...props }: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>
);
export const ExchangeIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><path d="M4 18V9m5 9V5m5 13v-7m5 7V3"/><path d="M2 21h20"/></Icon>;
export const FeedIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="17" r="3"/></Icon>;
export const PortfolioIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M8 6V4h8v2m-13 6h18"/></Icon>;
export const TrophyIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4m-4 1v5m-4 2h8"/></Icon>;
export const AdminIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0m1-9v5m-2.5-2.5h5"/></Icon>;
export const BoltIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><path d="m13 2-9 12h7l-1 8 9-12h-7l1-8Z"/></Icon>;
export const ArrowIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><path d="m6 9 6-6 6 6M12 3v18"/></Icon>;
export const SparkIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Z"/><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z"/></Icon>;
export const ShieldIcon = (p: SVGProps<SVGSVGElement>) => <Icon {...p}><path d="M12 3 4 6v5c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6l-8-3Z"/><path d="m9 12 2 2 4-5"/></Icon>;

