# Spec Giao Diện AI Agent Workspace

Tài liệu này là bản spec để tái tạo giao diện trong [`overview.png`](./overview.png). Mục tiêu là dựng lại một dashboard sci-fi/isometric có bố cục, ánh sáng, tỷ lệ và dữ liệu rất gần ảnh mẫu.

## 1. Mục Tiêu

- Màn hình desktop 16:9, full-bleed, nền tối xanh đen.
- Trung tâm là một workspace 3D/isometric dạng mini city.
- Có sidebar trái, top bar, analytics rail phải, và dải hoạt động ở đáy.
- Không biến thành landing page hoặc dashboard phẳng.

## 2. Bố Cục Tổng Thể

| Vùng | Kích thước gợi ý | Nội dung |
| --- | --- | --- |
| Sidebar trái | 248-264px | logo, navigation, active agents |
| Top bar | 64-72px | system status, project selector, action icons, avatar |
| Main center | phần còn lại | H1, subhead, scene isometric, task overlays |
| Right rail | 336-368px | system overview, throughput, model usage |
| Bottom strip | 120-140px | workflow activity, model picker |

## 3. Tone Màu

Tone màu cần lấy cảm giác từ ảnh Novatech nhưng chuyển sang dark mode:

- Premium, mềm, sạch, có ánh sáng pastel.
- Nền chính là midnight navy / near-black purple, không đen phẳng.
- Glow chính là lavender, violet, pink và cyan nhạt.
- Glass card hơi sáng hơn nền, viền mảnh, blur nhẹ.
- Text dùng off-white, không dùng trắng gắt.
- Accent vàng/amber chỉ dùng ít cho Deployment và warning, không làm màu chủ đạo.

Không dùng cyberpunk quá gắt kiểu neon xanh dương bão hòa toàn màn hình. Giao diện phải giống một workspace AI cao cấp, dịu mắt hơn, có cảm giác "soft futuristic portal" nhưng vẫn dark.

## 4. Token Hình Ảnh

| Token | Giá trị |
| --- | --- |
| bg-0 | `#070815` |
| bg-1 | `#101129` |
| bg-glow | `#241B46` |
| surface | `rgba(22,24,48,0.78)` |
| surface-2 | `rgba(36,32,70,0.72)` |
| border | `rgba(232,224,255,0.12)` |
| text | `#F7F3FF` |
| muted | `#AFA8C7` |
| lavender | `#A78BFA` |
| violet | `#8B5CF6` |
| pink | `#F472B6` |
| peach | `#FDBA9B` |
| cyan | `#67E8F9` |
| blue | `#60A5FA` |
| green | `#86EFAC` |
| amber | `#FBBF24` |

## 5. Typography

- Font chính: Inter.
- Số liệu, timestamp, version: JetBrains Mono.
- H1: lớn, đậm, white, đặt ở góc trên trái vùng main.
- Subtitle: nhỏ hơn, muted, ngay dưới H1.

## 6. Main Composition

### 6.1 Hero Text

- Title: `AI Agent Workspace`
- Subhead: `Coordinate your agents. Ship better software.`
- Vị trí: góc trên trái của vùng nội dung chính.

### 6.2 Scene Trung Tâm

- Scene chiếm phần lớn diện tích trung tâm.
- Hình thái: một cụm công trình mini 3D/isometric, có đèn neon, sàn phát sáng, đường nối workflow, robot nhỏ và các màn hình.
- Màu chủ đạo theo khu:
  - Planning: lavender / blue
  - Code: cyan / teal
  - Documents: violet / pink
  - Workflow Engine: soft blue / lavender
  - Testing: violet
  - Monitoring: peach / amber
  - Deployment: gold / warm pink

Scene cần có một lớp glow lớn rất mềm phía sau workspace, giống ánh sáng portal trong ảnh Novatech. Glow này chỉ tạo chiều sâu, không được làm mờ nội dung chính.

### 6.3 Các Zone

| Zone | Vị trí tương đối | Text trên biển |
| --- | --- | --- |
| Planning | trên - giữa | `PLANNING` / `Strategy & Roadmap` |
| Code | giữa - trái | `CODE` / `Development Zone` |
| Documents | trên - phải | `DOCUMENTS` / `Knowledge Base` |
| Workflow Engine | giữa | `WORKFLOW ENGINE` / `Orchestration & Logic` |
| Testing | giữa - phải | `TESTING` / `Quality Assurance` |
| Monitoring | dưới - trái | `MONITORING` / `Observability & Metrics` |
| Deployment | dưới - phải | `DEPLOYMENT` / `CI/CD Pipeline` |

Mỗi zone cần có:

- một nền platform nổi,
- viền emissive,
- nội thất gợi phòng làm việc,
- một robot/avatar nhỏ,
- đường nối workflow phát sáng.

## 7. Floating Task Cards

Task cards là các hộp glassmorphism nhỏ, nổi trên scene.

### 7.1 Cấu Trúc Card

- Title
- Role
- Status
- ETA
- Priority badge nếu cần

### 7.2 Card Cần Có

- `Define API Schema` / `Planner` / `In Progress` / `High` / `ETA 10m`
- `Implement Auth` / `Coder` / `In Progress` / `High` / `ETA 25m`
- `Architecture Doc` / `RAG Search` / `Completed`
- `Run E2E Tests` / `Tester` / `In Progress` / `ETA 15m`
- `Deploy to Prod` / `Deployer` / `In Progress` / `ETA 8m`
- `Error Rate` / `2.48%` / `+12.5% vs last 24h`

### 7.3 Vị Trí Gợi Ý

- `Define API Schema`: trên khu Planning.
- `Implement Auth`: trên khu Code.
- `Architecture Doc`: trên khu Documents.
- `Run E2E Tests`: trên khu Testing.
- `Deploy to Prod`: trên khu Deployment.
- `Error Rate`: gần khu Monitoring.

## 8. Sidebar Trái

### 8.1 Logo / Brand

- Brand: `AgenticOS`
- Version: `v2.4.1`
- Icon đầu: biểu tượng app dạng blue neon.

### 8.2 Navigation

- Overview
- Agents
- Projects
- Workflows
- Tasks
- Knowledge
- Integrations
- Analytics
- Settings

### 8.3 Active Agents Widget

- Heading: `Active Agents`
- Counter: `12 / 24`
- Danh sách:
  - Planner / GPT-4o / Working
  - Coder / Claude 3.5 / Coding
  - Reviewer / GPT-4o / Reviewing
  - Tester / Gemini 1.5 / Testing
  - Deployer / GPT-4o / Deploying

## 9. Top Bar

- System Status: `All Systems Operational`
- Project selector: `Acme Platform`
- Action icons: search, settings, notifications
- Avatar người dùng ở góc phải

## 10. Right Rail

### 10.1 System Overview

- Active Agents: `12`
- Planning: `2`
- Coding: `4`
- Testing: `2`
- Deploying: `1`
- Monitoring: `3`

### 10.2 Task Throughput

- Total: `186`
- Growth: `+14.2%`
- Chart: line chart 24h

### 10.3 Model Usage

- GPT-4o: `38.4%` / `2.1M`
- Claude 3.5: `28.7%` / `1.6M`
- Gemini 1.5: `16.3%` / `910K`
- Llama 3.1: `10.2%` / `570K`
- Other: `6.4%` / `360K`

## 11. Bottom Strip

### 11.1 Workflow Activity

- Planner created tasks / `2m ago`
- Coder pushed changes / `4m ago`
- Reviewer left comments / `6m ago`
- Tester found 2 issues / `8m ago`
- Deployer deployed to staging / `10m ago`

### 11.2 Select Model for New Agent

- GPT-4o / Best for general tasks
- Claude 3.5 Sonnet / Best for coding
- Gemini 1.5 Pro / Best for long context
- Llama 3.1 70B / Best for open-source
- Custom Model / Bring your own model

## 12. Visual Rules

- Nền phải luôn tối, không dùng trắng làm màu nền chính.
- Không dùng black thuần `#000`; dùng navy/purple gần đen.
- Ánh sáng cần mềm như pastel neon, không dùng glow gắt bão hòa.
- Card radius nhỏ, glassmorphism nhẹ, border mảnh.
- Có glow/neon nhưng không quá chói.
- Center scene phải là điểm nhìn đầu tiên.
- Không dùng stock photo hoặc hero illustration tách đôi.
- Không biến scene thành dashboard analytics thuần.
- Giữ khoảng trống đủ để các label không đè lên nhau.

## 13. Gợi Ý Triển Khai

### Option A: Scene 3D Thật

- Dùng orthographic/isometric camera.
- Dùng emissive materials + bloom nhẹ.
- Dùng robot / workstation / room modules riêng.
- Dùng HTML overlay cho task cards và charts.

### Option B: Render Tĩnh

- Dùng một ảnh render isometric chất lượng cao làm background.
- Giữ nguyên layout chrome xung quanh.
- Chỉ overlay các panel và card động lên trên.

## 14. Asset 3D Cụ Thể

Nếu làm scene 3D thật, chuẩn bị asset theo dạng modular GLB để dễ compose bằng R3F.

### 14.1 Folder Asset

```text
assets/
  models/
    workspace/
      base-platform.glb
      zone-planning.glb
      zone-code.glb
      zone-documents.glb
      zone-workflow-engine.glb
      zone-testing.glb
      zone-monitoring.glb
      zone-deployment.glb
      robot-agent.glb
      neon-path-segment.glb
      glass-task-anchor.glb
      props-terminal.glb
      props-server-rack.glb
      props-desk.glb
      props-hologram-column.glb
      props-palm-planter.glb
  textures/
    workspace/
      floor-grid.ktx2
      metal-panel.ktx2
      brushed-dark-metal.ktx2
      screen-emission.ktx2
      soft-glow-mask.ktx2
```

### 14.2 Asset Budget

| Asset group | Triangle budget | Texture budget | Notes |
| --- | ---: | ---: | --- |
| Base platform | 8k-15k | 1x 1024 KTX2 | Nền sàn, panel, grid line |
| Mỗi zone module | 12k-30k | 1-2x 1024 KTX2 | Có nội thất, biển zone, emissive strips |
| Robot agent | 4k-8k | 1x 512 KTX2 | Dùng lại 1 model, đổi material/accent theo role |
| Props nhỏ | 1k-5k mỗi item | 512 KTX2 | Terminal, rack, cây, desk |
| Tổng scene | dưới 180k tris | dưới 12MB compressed | Target desktop smooth 60 FPS |

### 14.3 Quy Chuẩn Model

- Format: `.glb`, nén Meshopt hoặc Draco, texture KTX2/Basis.
- Pivot mỗi zone đặt tại tâm platform, đáy model ở `y = 0`.
- Scale thống nhất: 1 unit = 1 meter.
- Material slots cần có tên rõ:
  - `mat_dark_metal`
  - `mat_floor_panel`
  - `mat_glass`
  - `mat_screen`
  - `mat_neon_primary`
  - `mat_neon_secondary`
- Text trên biển zone nên là mesh/text riêng để có thể thay đổi màu emissive.
- Robot cần có bones hoặc ít nhất tách mesh: `head`, `body`, `arms`, `legs`, `visor`, `accent_light`.

### 14.4 Scene Coordinates

| Zone | Position `[x,y,z]` | Rotation Y | Scale | Accent |
| --- | --- | ---: | ---: | --- |
| Planning | `[0,0,-6]` | `0` | `1` | lavender/blue |
| Code | `[-7,0,-1.5]` | `0.15` | `1` | cyan/teal |
| Documents | `[7,0,-5]` | `-0.2` | `1` | violet/pink |
| Workflow Engine | `[0,0,0]` | `0` | `1.05` | soft blue/lavender |
| Testing | `[6,0,2.2]` | `-0.25` | `1` | violet |
| Monitoring | `[-4.8,0,5.2]` | `0.2` | `1` | peach/amber |
| Deployment | `[4.5,0,5.4]` | `-0.1` | `1` | gold/warm pink |

Robot positions:

| Agent | Role | Position `[x,y,z]` | Accent |
| --- | --- | --- | --- |
| `planner-01` | Planner | `[1.4,0.2,-4.9]` | blue |
| `coder-01` | Coder | `[-6.1,0.2,-0.6]` | cyan |
| `reviewer-01` | Reviewer | `[-1.2,0.2,-1.5]` | green |
| `tester-01` | Tester | `[6.2,0.2,3.1]` | violet |
| `deployer-01` | Deployer | `[3.7,0.2,5.7]` | gold |
| `monitor-01` | Monitor | `[-4.1,0.2,4.5]` | peach |

Workflow paths:

- Planning -> Workflow Engine
- Code -> Workflow Engine
- Documents -> Workflow Engine
- Workflow Engine -> Testing
- Testing -> Deployment
- Deployment -> Monitoring
- Monitoring -> Planning

Render path bằng `CatmullRomCurve3`, tube geometry mảnh, emissive material, và animated dash texture.

## 15. Camera, Lighting, Bloom, Material

### 15.1 Camera

Use orthographic camera để giữ cảm giác isometric như ảnh.

```tsx
<Canvas
  orthographic
  dpr={[1, 2]}
  camera={{
    position: [14, 13, 14],
    zoom: 58,
    near: 0.1,
    far: 100
  }}
>
```

Camera target:

```ts
controls.target.set(0, 0.6, 0);
controls.enableRotate = false;
controls.enablePan = false;
controls.enableZoom = false;
```

Nếu cần responsive:

- Desktop wide: `zoom 56-62`
- Laptop: `zoom 48-54`
- Mobile fallback: dùng static render hoặc simplified 2D layout, không ép full 3D scene.

### 15.2 Renderer

```tsx
<Canvas
  gl={{
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1.08
  }}
  shadows
>
```

Background nên là CSS/R3F gradient rất tối:

```css
background:
  radial-gradient(circle at 68% 30%, rgba(167,139,250,0.20), transparent 34%),
  radial-gradient(circle at 46% 65%, rgba(244,114,182,0.10), transparent 38%),
  linear-gradient(135deg, #070815 0%, #101129 52%, #090B18 100%);
```

### 15.3 Lighting

```tsx
<ambientLight intensity={0.28} />
<hemisphereLight args={['#b8a7ff', '#070815', 0.65]} />
<directionalLight
  position={[8, 14, 6]}
  intensity={1.25}
  castShadow
  shadow-mapSize={[2048, 2048]}
/>
<directionalLight position={[-8, 8, -6]} intensity={0.35} color="#67E8F9" />
```

Zone point lights:

| Zone | Color | Intensity | Distance |
| --- | --- | ---: | ---: |
| Planning | `#60A5FA` | `1.4` | `7` |
| Code | `#67E8F9` | `1.5` | `7` |
| Documents | `#A78BFA` | `1.6` | `7` |
| Workflow | `#8B5CF6` | `1.3` | `8` |
| Testing | `#F472B6` | `1.1` | `6` |
| Monitoring | `#FDBA9B` | `1.0` | `6` |
| Deployment | `#FBBF24` | `1.0` | `6` |

### 15.4 Bloom / Postprocessing

Bloom phải mềm, không làm cháy chữ hoặc panel.

```tsx
<EffectComposer multisampling={0}>
  <Bloom
    intensity={0.72}
    luminanceThreshold={0.42}
    luminanceSmoothing={0.18}
    mipmapBlur
  />
  <Vignette eskil={false} offset={0.18} darkness={0.55} />
</EffectComposer>
```

Không dùng bloom intensity trên `1.2` trừ khi scene quá tối.

### 15.5 Material Preset

Dark metal:

```ts
{
  color: '#15162A',
  roughness: 0.62,
  metalness: 0.58,
  envMapIntensity: 0.55
}
```

Frosted glass:

```ts
{
  color: '#E8E0FF',
  transmission: 0.28,
  opacity: 0.32,
  roughness: 0.18,
  metalness: 0,
  transparent: true
}
```

Neon strip:

```ts
{
  color: accent,
  emissive: accent,
  emissiveIntensity: 2.4,
  toneMapped: false
}
```

Screen material:

```ts
{
  color: '#0B1022',
  emissive: accent,
  emissiveIntensity: 1.35,
  roughness: 0.35,
  metalness: 0.15
}
```

Robot shell:

```ts
{
  color: '#F7F3FF',
  roughness: 0.42,
  metalness: 0.18,
  envMapIntensity: 0.8
}
```

## 16. R3F Implementation Spec

### 16.1 Package Stack

```text
react
react-dom
three
@react-three/fiber
@react-three/drei
@react-three/postprocessing
zustand
framer-motion
lucide-react
```

### 16.2 Component Tree

```text
App
  AppShell
    Sidebar
    TopBar
    MainWorkspace
      WorkspaceCanvas
        WorkspaceScene
          BasePlatform
          ZoneModule x7
          WorkflowPathLayer
          AgentLayer
          TaskAnchorLayer
          SoftPortalGlow
      FloatingTaskCards
      BottomActivityStrip
    RightAnalyticsRail
```

### 16.3 Data Types

```ts
type ZoneId =
  | 'planning'
  | 'code'
  | 'documents'
  | 'workflow'
  | 'testing'
  | 'monitoring'
  | 'deployment';

type AgentState =
  | 'idle'
  | 'thinking'
  | 'moving'
  | 'working'
  | 'reviewing'
  | 'testing'
  | 'deploying'
  | 'blocked'
  | 'complete';

type ZoneConfig = {
  id: ZoneId;
  title: string;
  subtitle: string;
  position: [number, number, number];
  rotationY: number;
  accent: string;
  modelUrl: string;
};

type AgentConfig = {
  id: string;
  name: string;
  role: string;
  model: string;
  state: AgentState;
  zoneId: ZoneId;
  position: [number, number, number];
  accent: string;
};

type TaskCard = {
  id: string;
  title: string;
  role: string;
  status: 'In Progress' | 'Completed' | 'Blocked';
  priority?: 'High' | 'Medium' | 'Low';
  eta?: string;
  zoneId: ZoneId;
  screenPosition?: { left: string; top: string };
};
```

### 16.4 Zustand Store

```ts
type WorkspaceStore = {
  zones: ZoneConfig[];
  agents: AgentConfig[];
  tasks: TaskCard[];
  selectedAgentId: string | null;
  setAgentState: (agentId: string, state: AgentState) => void;
  moveAgentToZone: (agentId: string, zoneId: ZoneId) => void;
  selectAgent: (agentId: string | null) => void;
};
```

### 16.5 Animation States

| State | Visual behavior |
| --- | --- |
| `idle` | robot bob nhẹ, accent light thở chậm |
| `thinking` | head tilt, visor glow pulse lavender |
| `moving` | di chuyển theo workflow path, chân/arms swing nhẹ |
| `working` | đứng ở workstation, màn hình khu vực sáng hơn |
| `reviewing` | green accent, tooltip hiện review activity |
| `testing` | violet scan ring quanh robot |
| `deploying` | gold path pulse từ Testing sang Deployment |
| `blocked` | red/pink warning pulse, task card badge đổi màu |
| `complete` | green check burst nhỏ rồi trở về idle |

Animation technical notes:

- Dùng `useFrame` cho bob, rotation nhỏ và path progress.
- Dùng `react-spring/three` hoặc `framer-motion-3d` cho transition mềm.
- Dùng `CatmullRomCurve3.getPoint(progress)` để move agent trên path.
- Mỗi agent có `targetZoneId`, `pathProgress`, `stateStartedAt`.
- Không animate quá nhiều HTML card; chỉ dùng opacity/translate nhẹ để tránh rối.

### 16.6 Scene Components

`ZoneModule`:

```tsx
function ZoneModule({ zone }: { zone: ZoneConfig }) {
  const gltf = useGLTF(zone.modelUrl);

  return (
    <group position={zone.position} rotation-y={zone.rotationY}>
      <primitive object={gltf.scene} />
      <pointLight color={zone.accent} intensity={1.2} distance={6} />
      <Text
        position={[0, 2.2, -1.4]}
        fontSize={0.42}
        color={zone.accent}
        anchorX="center"
        anchorY="middle"
      >
        {zone.title}
      </Text>
    </group>
  );
}
```

`AgentRobot`:

```tsx
function AgentRobot({ agent }: { agent: AgentConfig }) {
  const ref = useRef<THREE.Group>(null);
  const gltf = useGLTF('/assets/models/workspace/robot-agent.glb');

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    ref.current.position.y = agent.position[1] + Math.sin(t * 2.2) * 0.045;
    ref.current.rotation.y = Math.sin(t * 1.3) * 0.08;
  });

  return (
    <group ref={ref} position={agent.position}>
      <primitive object={gltf.scene} />
      <pointLight color={agent.accent} intensity={0.8} distance={2.8} />
    </group>
  );
}
```

`WorkflowPathLayer`:

```tsx
function WorkflowPathLayer({ paths }: { paths: THREE.Vector3[][] }) {
  return (
    <>
      {paths.map((points, index) => (
        <TrailPath key={index} points={points} color="#A78BFA" />
      ))}
    </>
  );
}
```

### 16.7 HTML Overlay Mapping

Floating task cards nên dùng HTML tuyệt đối phía trên canvas để text luôn sắc nét.

| Card | CSS position |
| --- | --- |
| Define API Schema | `left: 26%; top: 18%` |
| Implement Auth | `left: 14%; top: 40%` |
| Architecture Doc | `right: 4%; top: 22%` |
| Run E2E Tests | `right: 6%; top: 58%` |
| Deploy to Prod | `right: 6%; bottom: 10%` |
| Error Rate | `left: 4%; bottom: 9%` |

Các vị trí này phải được chỉnh bằng Playwright screenshot ở viewport `1680x945`.

## 17. Build Plan App Thật

1. Dựng AppShell bằng CSS grid/flex đúng layout.
2. Dựng static HUD: sidebar, top bar, right rail, bottom strip.
3. Dựng `WorkspaceCanvas` với camera, lights, bloom, background.
4. Load base platform và 7 zone modules.
5. Thêm robot agents và workflow path animation.
6. Thêm floating task cards bằng HTML overlay.
7. Nối Zustand store với mock data.
8. Sau đó mới nối event stream/CLI backend thật.
9. Chạy visual QA bằng screenshot desktop/laptop/mobile.

## 18. Acceptance Criteria

- Ở viewport 1680x945, bố cục phải bám sát ảnh mẫu.
- Sidebar trái và rail phải không được chồng lên scene trung tâm.
- H1, task cards, charts và bottom strip đều đọc rõ.
- Có cảm giác một workspace vận hành AI thật, không phải UI demo chung chung.
- Tổng thể phải là dark mode mềm theo hướng lavender/pink/cyan premium, không phải dark blue cyberpunk quá lạnh.
- Canvas không được blank; scene phải có ít nhất 7 zone, 6 robot, và các workflow path phát sáng.
- Bloom không được làm mờ chữ trong task cards hoặc HUD.
- Khi agent đổi state, robot và card phải đổi visual state trong dưới 150ms.
- Scene desktop phải giữ trên 55 FPS ở máy có GPU phổ thông.

## 19. One-Shot Prompt

```text
Create a single-screen dark premium sci-fi desktop dashboard that matches the composition of image/overview.png, but use the soft pastel-lavender visual tone of the Novatech reference transformed into dark mode. Use a fixed left sidebar, a top status bar, a dominant isometric 3D workspace in the center, a right analytics rail, and a bottom activity strip. Keep the exact labels and data values from the reference. The center workspace must look like a miniature neon 3D AI operations city with zones named PLANNING, CODE, DOCUMENTS, WORKFLOW ENGINE, TESTING, MONITORING, and DEPLOYMENT. Use midnight navy and near-black violet backgrounds, frosted glass cards, soft lavender/pink/cyan glow, subtle bloom, luminous portal-like depth, and floating task cards with the task names Define API Schema, Implement Auth, Architecture Doc, Run E2E Tests, and Deploy to Prod. Do not turn it into a plain analytics page, a landing page, or a harsh saturated cyberpunk UI. Preserve the overall proportions, spacing, and dark premium palette.
```

## 20. Notes

- `overview.png` là visual target, không phải asset để nhúng vào final app.
- File này nên được dùng làm source-of-truth cho việc dựng UI sau này.
