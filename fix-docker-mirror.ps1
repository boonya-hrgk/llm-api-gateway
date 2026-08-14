# Docker 镜像加速器一键修复脚本（PowerShell）
# 原因：阿里云镜像源 5lw1kglm.mirror.aliyuncs.com 返回 403，已失效
# 方案：替换为可用的镜像源，或直接走官方源

Write-Host "=== Docker 镜像源修复工具 ===" -ForegroundColor Cyan
Write-Host ""

$daemonPath = "$env:USERPROFILE\.docker\daemon.json"

Write-Host "当前配置文件路径: $daemonPath"
Write-Host ""

# 读取现有配置
if (Test-Path $daemonPath) {
    $config = Get-Content $daemonPath -Raw | ConvertFrom-Json
    Write-Host "当前镜像源配置:" -ForegroundColor Yellow
    if ($config.'registry-mirrors') {
        $config.'registry-mirrors' | ForEach-Object { Write-Host "  $_" }
    } else {
        Write-Host "  (未配置)"
    }
} else {
    $config = [PSCustomObject]@{}
    Write-Host "  (无配置文件，将新建)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "请选择修复方案:" -ForegroundColor Green
Write-Host "  1) 使用中科大镜像源 (推荐)"
Write-Host "  2) 使用七牛云镜像源"
Write-Host "  3) 清除所有镜像源（直连官方）"
Write-Host "  4) 退出，不修改"
Write-Host ""

$choice = Read-Host "请输入选项 (1/2/3/4)"

switch ($choice) {
    "1" {
        $mirrors = @("https://docker.mirrors.ustc.edu.cn")
        $config | Add-Member -MemberType NoteProperty -Name 'registry-mirrors' -Value $mirrors -Force
        Write-Host "已设置: 中科大镜像源" -ForegroundColor Green
    }
    "2" {
        $mirrors = @("https://reg-mirror.qiniu.com")
        $config | Add-Member -MemberType NoteProperty -Name 'registry-mirrors' -Value $mirrors -Force
        Write-Host "已设置: 七牛云镜像源" -ForegroundColor Green
    }
    "3" {
        if ($config.PSObject.Properties.Name -contains 'registry-mirrors') {
            $config.PSObject.Properties.Remove('registry-mirrors')
        }
        Write-Host "已清除所有镜像源，将直连 Docker Hub" -ForegroundColor Green
    }
    "4" {
        Write-Host "已取消，未做任何修改" -ForegroundColor Yellow
        exit
    }
    default {
        Write-Host "无效选项，退出" -ForegroundColor Red
        exit
    }
}

# 写回配置文件
$config | ConvertTo-Json -Depth 10 | Set-Content $daemonPath -Encoding UTF8
Write-Host ""
Write-Host "配置已写入: $daemonPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步: 重启 Docker Desktop 后重试 docker build" -ForegroundColor Yellow
Write-Host "  Docker Desktop 右上角齿轮 -> Troubleshoot -> Restart"
Write-Host "  或在 PowerShell 执行: Restart-Service com.docker.service"
