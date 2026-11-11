export interface DepotLocation {
  lat: number;
  lng: number;
}

export interface JamarBranchInfo {
  branchKey: string;
  address: string;
}

export interface NormalizedAddressResult {
  clean: string;
  complement: string;
  found: boolean;
}

export interface GeocodeResultData {
  lat: number;
  lng: number;
  display: string;
  barrio: string;
  municipio: string;
  confidence: string;
  strategy: string;
}

export interface OrderItem {
  id: string;
  cliente: string;
  direccion: string;
  direccionOriginal: string;
  ciudad: string;
  barrio: string;
  telefono: string;
  pedido: string;
  descripcion: string;
  vol: number;
  lat: number | null;
  lng: number | null;
  status: 'OK' | 'ALERTA' | 'EXCLUIDO';
  confidence: string;
  strategy: string;
  zone?: string;
  rowIdx?: number;
  _jamarBranch?: string;
}

export interface PhysicalDestination {
  id: number;
  key: string;
  cliente: string;
  direccion: string;
  direccionOriginal: string;
  ciudad: string;
  barrio: string;
  telefono: string;
  vol: number;
  orders: OrderItem[];
  lat: number | null;
  lng: number | null;
  status: 'OK' | 'ALERTA' | 'EXCLUIDO';
  confidence: string;
  strategy: string;
  zone: string;
  isMultiDelivery?: boolean;
  clienteDisplay?: string;
  entregas?: any[];
  pedidos?: string[];
  _sourceRouteId?: number;
  _sharedLocationStops?: PhysicalDestination[];
}

export interface RouteOptionAlternative {
  stops: PhysicalDestination[];
  km: number;
  vol: number;
  realKm?: number | null;
  realDurationMin?: number | null;
}

export interface DeliveryRoute {
  id: number;
  name?: string;
  color: string;
  stops?: PhysicalDestination[];
  option: 'A' | 'B';
  alts: {
    A?: RouteOptionAlternative;
    B?: RouteOptionAlternative;
    a?: PhysicalDestination[];
    b?: PhysicalDestination[];
    da?: number;
    db?: number;
    chosen?: 'A' | 'B';
    realDa?: number | null;
    realDb?: number | null;
    realDurA?: number | null;
    realDurB?: number | null;
    [key: string]: any;
  };
  visible?: boolean;
  realKm?: number | null;
  realDurationMin?: number | null;
  _userManualOption?: boolean;
  [key: string]: any;
}

export interface PreprocessStats {
  rows: number;
  cityExcluded: number;
  freightExcluded: number;
  cendisExcluded: number;
  branchHomologated: number;
  corrected: Record<string, number>;
  cities: Record<string, number>;
  orders: number;
  destinations: number;
  excludedRows: any[];
}

export interface ColumnMapping {
  name: string;
  addr: string;
  city: string;
  neigh: string;
  phone: string;
  order: string;
  desc: string;
  vol?: string;
  volume?: string;
  id?: string;
  [key: string]: any;
}

export interface GlobalAppState {
  rawRows: any[];
  orders: OrderItem[];
  destinations: PhysicalDestination[];
  alerts: PhysicalDestination[];
  routes: DeliveryRoute[];
  stats: Partial<PreprocessStats>;
  map: any | null;
  tiles: any | null;
  routeLayer: any | null;
  markers: any | null;
  stopMarkers: any[];
  currentRouteIndex: number;
  viewMode: 'single' | 'all';
  routeViewStyle: 'completo' | 'pines';
  pinSize: 'micro' | 'estandar';
  routeDistributionMode: 'comfort' | 'max_capacity';
  colors: string[];
  isGeocoding?: boolean;
}
