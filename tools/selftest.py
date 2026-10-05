# -*- coding: utf-8 -*-
"""selftest.py —— 投影正确性自检（往返一致性 + 朝向我们约定的方向）"""
import globe as g

T = 0.5
tests = [(39.9, 116.4), (51.5, -0.13), (0, 0), (-33.87, 151.21),
         (40.71, -74.01), (60, 100), (18, 116), (-20, -60)]
bad = 0
for lat, lon in tests:
    for yaw in (0, 20, 116, -75):
        for pitch in (0, 18, -25):
            vx, vy, vz = g.project(lat, lon, yaw, pitch)
            if vz <= 0:
                continue
            blat, blon, _ = g.unproject(vx, vy, yaw, pitch)
            dl = abs(((blon - lon + 180) % 360) - 180)
            if abs(blat - lat) > T or dl > T:
                bad += 1
                print(f"MISMATCH lat={lat} lon={lon} yaw={yaw} pitch={pitch} -> {blat:.2f},{blon:.2f}")
print("往返一致性:", "OK" if bad == 0 else f"FAIL ({bad})")

# 朝向：东经在画面右侧、北纬在画面上方、pitch>0 时北极可见
for lat, lon in [(0, 10), (10, 0), (80, 0)]:
    vx, vy, vz = g.project(lat, lon, 0, 18.0)
    print(f"  lat={lat:>3} lon={lon:>3} -> 屏上 x={vx:+.2f} y={vy:+.2f} z={vz:+.2f}")

print()
for name, yaw in (("太平洋/东亚", 116.0), ("欧洲/非洲", 20.0), ("美洲", -75.0)):
    la, lo, _ = g.unproject(0, 0, yaw, 18.0)
    print(f"{name}: 正中 = {la:.1f}N {lo:.1f}E")
    for city, (cla, clo) in {"北京": (39.9, 116.4), "柏林": (52.5, 13.4),
                             "纽约": (40.7, -74.0), "悉尼": (-33.9, 151.2)}.items():
        vx, vy, vz = g.project(cla, clo, yaw, 18.0)
        tag = "可见" if vz > 0 else "背面"
        print(f"    {city}: x={vx:+.2f} y={vy:+.2f} z={vz:+.2f} {tag}")
