import {
  HeartPulse, Wallet, Briefcase, House, Users, GraduationCap, Plane, Target, FileText, LifeBuoy,
  PawPrint, HandHeart, Layers,
} from 'lucide-react';

export const LIFE_AREA_ICONS = {
  'heart-pulse': HeartPulse, wallet: Wallet, briefcase: Briefcase, house: House, users: Users,
  'graduation-cap': GraduationCap, plane: Plane, target: Target, 'file-text': FileText,
  'life-buoy': LifeBuoy, 'paw-print': PawPrint, 'hand-heart': HandHeart, layers: Layers,
};

export function LifeAreaIcon({ name, size = 18 }) {
  const Icon = LIFE_AREA_ICONS[name] || Layers;
  return <Icon size={size} aria-hidden="true" />;
}
