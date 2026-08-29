// Verbindung zu Supabase — einmal hier eingerichtet, überall im Projekt nutzbar.
// Der "anon"-Schlüssel ist bewusst dafür gemacht, öffentlich im Code zu stehen.
// Der eigentliche Schutz kommt aus den RLS-Regeln in der Datenbank selbst.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://wsftiujnfywdxmzrvgqv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzZnRpdWpuZnl3ZHhtenJ2Z3F2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NTg0ODksImV4cCI6MjA3OTQzNDQ4OX0.h8NxTr-3MrdBN7mFxFPVweux1FduI9qI58UyPCxRcmE';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
