package main

import (
	"os/exec"
	"syscall"
	"unsafe"
)

const (
	createNoWindow             = 0x08000000
	jobObjectExtendedLimitInfo = 9
	jobObjectLimitKillOnClose  = 0x2000
	processSetQuota            = 0x0100
	processTerminate           = 0x0001
)

// Chrome から起動したときはコンソールがないので、llama-server のウインドウも出さない
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

type ioCounters struct {
	ReadOperationCount, WriteOperationCount, OtherOperationCount uint64
	ReadTransferCount, WriteTransferCount, OtherTransferCount    uint64
}

type basicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type extendedLimitInformation struct {
	BasicLimitInformation basicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

var killOnCloseJob uintptr

// このプログラムが強制終了されても llama-server が残らないよう、終了時に子も止まるジョブに入れる
func bindToParent(cmd *exec.Cmd) {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	if killOnCloseJob == 0 {
		job, _, _ := kernel32.NewProc("CreateJobObjectW").Call(0, 0)
		if job == 0 {
			return
		}
		var info extendedLimitInformation
		info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnClose
		ok, _, _ := kernel32.NewProc("SetInformationJobObject").Call(
			job, jobObjectExtendedLimitInfo, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
		if ok == 0 {
			return
		}
		killOnCloseJob = job
	}
	process, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(cmd.Process.Pid))
	if err != nil {
		return
	}
	defer syscall.CloseHandle(process)
	_, _, _ = kernel32.NewProc("AssignProcessToJobObject").Call(killOnCloseJob, uintptr(process))
}
